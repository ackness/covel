import {
  getPluginTrustInfo,
  type PluginEntryDefinition,
  type PluginRegistry,
  type PluginRegistryEntry,
} from "@covel/plugin-loader";
import type {
  PluginAPI,
  PluginToolkit,
  PluginEntryScope,
} from "@covel/runtime";
import {
  pluginMessagesFor,
  rpcActionNameSchema,
  type HttpPermissionDecl,
  type RpcTrustLevel,
} from "@covel/shared";
import {
  normalizeFormRefusal,
  draftHoldingHooks,
  draftHoldingKey,
  runSandboxWorker,
  validatePluginHookRegistration,
} from "@covel/runtime";
import {
  APP_EVENT_NAMES,
  channelBridgeV1,
  configFlowIdSchema,
  providerSourceIdSchema,
  scheduledTaskIdSchema,
} from "@covel/shared/platform";
import { isCapabilityKey, type CapabilityKey } from "@covel/shared/permissions";
import type { DataStore } from "@covel/store";
import type { PermissionService } from "../../../trust/permission-service.js";
import type { SecretVault } from "../../../trust/secret-vault.js";
import { isPluginCapabilityEffectivelyAllowed } from "./instance-plugins.js";
import {
  shortId,
  shortIdBatch,
  tool,
  withModelView,
  ToolError,
  withPendingProposals,
} from "@covel/tools";
import { z } from "zod";
import type { BootstrapPluginEntriesParams } from "./plugin-entry.js";
import { createEntryHttp, withCallSignal } from "./entry-http.js";
import { registerNamespaced } from "./plugin-wires.js";
import { PluginRegistrationError } from "./plugin-registration-error.js";
import { runnablePluginIds } from "../session/plugins.js";

const rpcOptionsSchema = z
  .object({
    description: z.string().optional(),
    trustLevel: z.enum(["builtin", "community"]).optional(),
  })
  .strict();

const appActionOptionsSchema = z
  .object({
    description: z.string().optional(),
    inputSchema: z.unknown().optional(),
    outputSchema: z.unknown().optional(),
    requiredCapabilities: z.array(z.string()).optional(),
  })
  .strict();

function isZodLikeSchema(value: unknown): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { safeParse?: unknown }).safeParse === "function"
  );
}

function validateCapabilitiesList(
  operation: string,
  capabilities: readonly string[] | undefined,
): void {
  for (const cap of capabilities ?? []) {
    if (!isCapabilityKey(cap)) {
      throw new PluginRegistrationError(
        operation,
        `unknown requiredCapability "${cap}"`,
      );
    }
  }
}

function parseIdWithSchema(
  schema: z.ZodType<string>,
  value: unknown,
  operation: string,
): string {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw new PluginRegistrationError(
      operation,
      parsed.error.issues.map((issue) => issue.message).join("; "),
    );
  }
  return parsed.data;
}

function assertActionAndHandler(
  operation: string,
  action: unknown,
  handler: unknown,
): void {
  if (
    typeof action !== "string" ||
    !action.trim() ||
    typeof handler !== "function"
  ) {
    throw new PluginRegistrationError(
      operation,
      "expected a non-empty action name and a handler function",
    );
  }
  parseIdWithSchema(rpcActionNameSchema, action, operation);
}

export interface PluginInstanceRuntimeSurface {
  readonly hostId?: string;
  readonly instanceData?: PluginAPI["instanceData"];
  readonly secrets?: PluginAPI["secrets"];
  readonly sandbox?: PluginAPI["sandbox"];
}

export function pickPluginInstanceSurfaceFields(
  surface: PluginInstanceSurface,
): PluginInstanceRuntimeSurface {
  return {
    ...(surface.hostId !== undefined ? { hostId: surface.hostId } : {}),
    ...(surface.instanceData !== undefined
      ? { instanceData: surface.instanceData }
      : {}),
    ...(surface.secrets !== undefined ? { secrets: surface.secrets } : {}),
    ...(surface.sandbox !== undefined ? { sandbox: surface.sandbox } : {}),
  };
}

export function packageHttpPermissions(
  entry: PluginRegistryEntry,
): readonly HttpPermissionDecl[] {
  return [
    ...(entry.packageManifest?.plugin.permissions?.http ?? []),
    ...(entry.manifests ?? []).flatMap(
      (item) => item.manifest.permissions?.http ?? [],
    ),
  ];
}

export interface PluginInstanceSurfaceDeps {
  readonly pluginId: string;
  readonly pluginRegistry?: PluginRegistry;
  readonly store: DataStore;
  readonly hostId?: string;
  readonly secretVault?: SecretVault;
  readonly getPermissionService?: () => PermissionService | undefined;
  readonly httpPermissions: readonly HttpPermissionDecl[];
}

export interface PluginInstanceSurface {
  readonly checkCapability: (key: CapabilityKey) => boolean;
  readonly hostId?: string;
  readonly instanceData?: PluginAPI["instanceData"];
  readonly secrets?: PluginAPI["secrets"];
  readonly sandbox?: PluginAPI["sandbox"];
  readonly http: PluginAPI["http"];
}

export function buildPluginInstanceSurface(
  deps: PluginInstanceSurfaceDeps,
): PluginInstanceSurface {
  const {
    pluginId,
    pluginRegistry,
    store,
    hostId,
    secretVault,
    getPermissionService,
    httpPermissions,
  } = deps;
  const packageManifest =
    pluginRegistry?.getCurrent(pluginId)?.packageManifest ??
    pluginRegistry?.get(pluginId)?.packageManifest;
  const pluginManifest = packageManifest?.plugin;
  const scope = pluginManifest?.scope ?? "session";

  const checkCapability = (key: CapabilityKey): boolean =>
    isPluginCapabilityEffectivelyAllowed(
      getPermissionService?.(),
      pluginRegistry,
      key,
      pluginId,
    );

  const requireInstanceScope = (): void => {
    if (!checkCapability("plugin.instanceScope")) {
      throw new Error(
        `Capability "plugin.instanceScope" is not allowed for plugin "${pluginId}"`,
      );
    }
  };
  const assertNamespace = (namespace: string): string => {
    if (
      typeof namespace !== "string" ||
      namespace.trim().length === 0 ||
      namespace.startsWith("_")
    ) {
      throw new Error(
        `Invalid instanceData namespace "${String(namespace)}": must be non-empty and must not start with "_"`,
      );
    }
    return namespace;
  };
  const assertKey = (key: string): string => {
    if (typeof key !== "string" || key.trim().length === 0) {
      throw new Error("Invalid instanceData key: must be non-empty");
    }
    return key;
  };

  const instanceData: PluginAPI["instanceData"] =
    scope === "instance" || scope === "both"
      ? {
          async get(namespace, key) {
            requireInstanceScope();
            const record = await store.getInstanceData(
              pluginId,
              assertNamespace(namespace),
              assertKey(key),
            );
            return record ? record.value : null;
          },
          async list(namespace) {
            requireInstanceScope();
            const records = await store.listInstanceData(
              pluginId,
              assertNamespace(namespace),
            );
            return records.map((record) => ({
              key: record.key,
              value: record.value,
              updatedAt: record.updatedAt,
            }));
          },
          async set(namespace, key, value) {
            requireInstanceScope();
            const ns = assertNamespace(namespace);
            const k = assertKey(key);
            const now = new Date().toISOString();
            await store.upsertInstanceData({
              pluginId,
              namespace: ns,
              key: k,
              value,
              createdAt: now,
              updatedAt: now,
            });
          },
          async delete(namespace, key) {
            requireInstanceScope();
            return store.deleteInstanceData(
              pluginId,
              assertNamespace(namespace),
              assertKey(key),
            );
          },
        }
      : undefined;

  const secrets: PluginAPI["secrets"] =
    pluginManifest?.permissions?.secrets === true && secretVault
      ? secretVault.forPlugin(pluginId, () => checkCapability("secrets.own"))
      : undefined;

  const sandbox: PluginAPI["sandbox"] =
    pluginManifest?.permissions?.sandboxWorker === true
      ? {
          async run(opts) {
            if (!checkCapability("compute.sandboxWorker")) {
              throw new Error(
                `Capability "compute.sandboxWorker" is not allowed for plugin "${pluginId}"`,
              );
            }
            return runSandboxWorker(opts);
          },
        }
      : undefined;

  const http = createEntryHttp(pluginId, httpPermissions, {
    canUseDeclaredHttp: () =>
      !getPermissionService || checkCapability("net.httpDeclared"),
    canUseLocalModels: () => checkCapability("network.localModels"),
    canUseAuthProxy: () =>
      pluginManifest?.permissions?.authProxy === true &&
      getPermissionService?.()?.snapshot().deploymentForm === "personal" &&
      checkCapability("net.authProxy"),
  });

  return {
    checkCapability,
    ...(hostId ? { hostId } : {}),
    ...(instanceData ? { instanceData } : {}),
    ...(secrets ? { secrets } : {}),
    ...(sandbox ? { sandbox } : {}),
    http,
  };
}

function validateOptions(
  schema: z.ZodType,
  operation: string,
  options: unknown,
): void {
  const result = schema.safeParse(options === undefined ? {} : options);
  if (!result.success)
    throw new PluginRegistrationError(
      operation,
      result.error.issues
        .map(
          (issue) => `${issue.path.join(".") || "options"}: ${issue.message}`,
        )
        .join("; "),
    );
}

export function buildEntryApi(
  params: BootstrapPluginEntriesParams,
  pluginId: string,
  batch: PluginEntryScope,
  provideExtension: PluginAPI["provideExtension"],
  httpPermissions: PluginEntryDefinition["httpPermissions"],
  contributions?: PluginEntryDefinition["contributions"],
): PluginAPI {
  const {
    discoveryMap,
    store,
    tools,
    hookPipeline,
    rpcRegistry,
    isCommunityHookApproved,
  } = params;
  let hookSeq = 0;
  const heldHooks = draftHoldingHooks(contributions);
  const trustInfo = getPluginTrustInfo(
    pluginId,
    discoveryMap.get(pluginId)?.source,
  );
  const pluginTrust: RpcTrustLevel = trustInfo.source;
  const surface = buildPluginInstanceSurface({
    pluginId,
    pluginRegistry: params.pluginRegistry,
    store,
    hostId: params.hostId,
    secretVault: params.secretVault,
    getPermissionService: params.getPermissionService,
    httpPermissions,
  });
  const http = surface.http;
  const extensions = params.extensions;
  let channelBridgePublished = false;
  const dispatchChannelBridge: PluginAPI["dispatchChannelBridge"] =
    extensions && surface.instanceData
      ? async (input, options) => {
          if (
            !channelBridgePublished ||
            !(await params.isInstanceServerCodeApproved?.(pluginId)) ||
            !surface.checkCapability("channel.bridge")
          ) {
            throw new Error(
              `Channel bridge is not allowed for plugin "${pluginId}"`,
            );
          }
          return batch.invoke(() =>
            extensions
              .createInstanceExecution({
                locale: options?.locale ?? "en-US",
                signal: options?.signal
                  ? AbortSignal.any([options.signal, batch.signal])
                  : batch.signal,
              })
              .run(channelBridgeV1, input),
          );
        }
      : undefined;
  if (dispatchChannelBridge) {
    batch.stage(() => {
      channelBridgePublished = true;
      batch.track(() => {
        channelBridgePublished = false;
      });
    });
  }
  // A service or extension provider's code sends its own requests, so it
  // reaches what its own package declares, whoever calls it.
  const ownUtils = <
    C extends { utils?: unknown; http?: unknown; signal: AbortSignal },
  >(
    context: C,
  ): C => {
    if (!context.utils && !context.http) return context;
    const scopedHttp = withCallSignal(http, context.signal);
    return {
      ...context,
      ...(context.utils ? { utils: scopedHttp } : {}),
      ...(context.http ? { http: scopedHttp } : {}),
    };
  };

  // Registration has no session authority. Reads are injected per tool call.
  const toolkit: PluginToolkit = {
    tool,
    z,
    shortId,
    shortIdBatch,
    withModelView,
    ToolError,
    withPendingProposals,
  };

  return {
    pluginId,
    ...pickPluginInstanceSurfaceFields(surface),
    ...(dispatchChannelBridge ? { dispatchChannelBridge } : {}),
    provideExtension(point, id, definition) {
      provideExtension(point, id, {
        ...definition,
        handler: (input, context) =>
          definition.handler(input, ownUtils(context)),
      });
    },
    signal: batch.signal,
    onDispose(cleanup) {
      batch.onDispose(cleanup);
    },
    toolkit,
    http,
    registerService(definition) {
      if (!params.services)
        throw new Error("Plugin service registry is unavailable");
      batch.stage(() => {
        try {
          // The registry hands a write service its write context; the
          // union's handler cannot be called with either context directly.
          const handler = definition.handler as (
            input: unknown,
            context: Parameters<typeof ownUtils>[0],
          ) => unknown;
          batch.track(
            params.services!.register(pluginId, {
              ...definition,
              handler: (input, context) =>
                batch.invoke(() => handler(input, ownUtils(context))),
            } as typeof definition),
          );
        } catch (error) {
          throw new PluginRegistrationError(
            "registerService",
            error instanceof Error ? error.message : String(error),
          );
        }
      });
    },
    registerTool(toolModule) {
      batch.stage(() => {
        try {
          batch.track(
            tools.registerPlugin(pluginId, {
              ...toolModule,
              execute: (input, context) =>
                batch.invoke(() => toolModule.execute(input, context)),
            }),
          );
        } catch (error) {
          throw new PluginRegistrationError(
            "registerTool",
            error instanceof Error ? error.message : String(error),
          );
        }
      });
    },
    on(event, handler, options) {
      batch.stage(() => {
        validatePluginHookRegistration(
          event,
          handler,
          options,
          (message) => new PluginRegistrationError("on", message),
        );
        hookSeq += 1;
        const sessionGuardedHandler: typeof handler = async (ctx, payload) => {
          if (
            pluginTrust === "community" &&
            !(await isCommunityHookApproved?.(ctx.sessionId, pluginId))
          ) {
            return { action: "continue" };
          }
          ctx.signal?.throwIfAborted();
          return batch.invoke(() => handler(ctx, payload));
        };
        const matchOption = options?.match;
        batch.track(
          hookPipeline.register({
            id: `${pluginId}:${event}:entry#${hookSeq}`,
            event,
            pluginId,
            handler: sessionGuardedHandler,
            ...(matchOption
              ? {
                  match: (payload) => {
                    const release = batch.retain();
                    try {
                      return matchOption(payload);
                    } finally {
                      release();
                    }
                  },
                }
              : {}),
            ...(typeof options?.timeoutMs === "number"
              ? { timeoutMs: options.timeoutMs }
              : {}),
            ...(options?.enforce ? { enforce: options.enforce } : {}),
            ...(heldHooks.has(draftHoldingKey(event, options?.enforce))
              ? { holdsDrafts: true }
              : {}),
            ...(pluginTrust === "community"
              ? {
                  runsFor: async (sessionId: string) =>
                    (await isCommunityHookApproved?.(sessionId, pluginId)) ??
                    false,
                }
              : {}),
          }),
        );
      });
    },
    registerRpc(action, handler, options) {
      batch.stage(() => {
        validateOptions(rpcOptionsSchema, "registerRpc", options);
        assertActionAndHandler("registerRpc", action, handler);
        if (rpcRegistry.getPluginAction(pluginId, action)) {
          throw new PluginRegistrationError(
            "registerRpc",
            `action "${action}" is already registered in this plugin`,
          );
        }
        batch.track(
          rpcRegistry.registerPluginHandler(
            pluginId,
            action,
            (request, context) => batch.invoke(() => handler(request, context)),
            options ?? {},
            pluginTrust,
          ),
        );
      });
    },
    registerAppAction(action, handler, options) {
      batch.stage(() => {
        if (!params.appActions) {
          throw new PluginRegistrationError(
            "registerAppAction",
            "Plugin app-action registry is unavailable",
          );
        }
        validateOptions(appActionOptionsSchema, "registerAppAction", options);
        assertActionAndHandler("registerAppAction", action, handler);
        if (
          options?.inputSchema !== undefined &&
          !isZodLikeSchema(options.inputSchema)
        ) {
          throw new PluginRegistrationError(
            "registerAppAction",
            "inputSchema must be a Zod schema",
          );
        }
        if (
          options?.outputSchema !== undefined &&
          !isZodLikeSchema(options.outputSchema)
        ) {
          throw new PluginRegistrationError(
            "registerAppAction",
            "outputSchema must be a Zod schema",
          );
        }
        validateCapabilitiesList(
          "registerAppAction",
          options?.requiredCapabilities,
        );
        try {
          batch.track(
            params.appActions.register(
              pluginId,
              action,
              (input, context) => batch.invoke(() => handler(input, context)),
              options ?? {},
              pluginTrust,
            ),
          );
        } catch (error) {
          throw new PluginRegistrationError(
            "registerAppAction",
            error instanceof Error ? error.message : String(error),
          );
        }
      });
    },
    registerConfigFlow(flowId, definition) {
      batch.stage(() => {
        if (!params.configFlows) {
          throw new PluginRegistrationError(
            "registerConfigFlow",
            "Plugin config-flow engine is unavailable",
          );
        }
        if (
          typeof flowId !== "string" ||
          !flowId.trim() ||
          !definition ||
          typeof definition !== "object" ||
          typeof definition.start !== "function" ||
          typeof definition.step !== "function"
        ) {
          throw new PluginRegistrationError(
            "registerConfigFlow",
            "expected a non-empty flowId and { start, step } handlers",
          );
        }
        parseIdWithSchema(configFlowIdSchema, flowId, "registerConfigFlow");
        if (
          definition.description !== undefined &&
          typeof definition.description !== "string"
        ) {
          throw new PluginRegistrationError(
            "registerConfigFlow",
            "description must be a string",
          );
        }
        if (
          definition.poll !== undefined &&
          typeof definition.poll !== "function"
        ) {
          throw new PluginRegistrationError(
            "registerConfigFlow",
            "poll must be a function when provided",
          );
        }
        if (
          definition.cancel !== undefined &&
          typeof definition.cancel !== "function"
        ) {
          throw new PluginRegistrationError(
            "registerConfigFlow",
            "cancel must be a function when provided",
          );
        }
        validateCapabilitiesList(
          "registerConfigFlow",
          definition.requiredCapabilities,
        );
        try {
          batch.track(
            params.configFlows.register(pluginId, flowId, {
              ...definition,
              start: (input, context) =>
                batch.invoke(() => definition.start(input, context)),
              step: (input, context) =>
                batch.invoke(() => definition.step(input, context)),
              ...(definition.poll
                ? {
                    poll: (context) =>
                      batch.invoke(() => definition.poll!(context)),
                  }
                : {}),
              ...(definition.cancel
                ? {
                    cancel: (context) =>
                      batch.invoke(() => definition.cancel!(context)),
                  }
                : {}),
            }),
          );
        } catch (error) {
          throw new PluginRegistrationError(
            "registerConfigFlow",
            error instanceof Error ? error.message : String(error),
          );
        }
      });
    },
    onAppEvent(event, handler) {
      batch.stage(() => {
        if (!params.appEvents) {
          throw new PluginRegistrationError(
            "onAppEvent",
            "AppEvent dispatcher is unavailable",
          );
        }
        if (
          typeof event !== "string" ||
          !(APP_EVENT_NAMES as readonly string[]).includes(event) ||
          typeof handler !== "function"
        ) {
          throw new PluginRegistrationError(
            "onAppEvent",
            "expected a valid AppEvent name and handler function",
          );
        }
        try {
          batch.track(
            params.appEvents.register(pluginId, event, (payload, context) =>
              batch.invoke(() => handler(payload, context)),
            ),
          );
        } catch (error) {
          throw new PluginRegistrationError(
            "onAppEvent",
            error instanceof Error ? error.message : String(error),
          );
        }
      });
    },
    registerScheduledTask(taskId, handler) {
      batch.stage(() => {
        if (!params.appScheduler) {
          throw new PluginRegistrationError(
            "registerScheduledTask",
            "AppScheduler is unavailable",
          );
        }
        if (
          typeof taskId !== "string" ||
          !taskId.trim() ||
          typeof handler !== "function"
        ) {
          throw new PluginRegistrationError(
            "registerScheduledTask",
            "expected a taskId and handler function",
          );
        }
        parseIdWithSchema(
          scheduledTaskIdSchema,
          taskId,
          "registerScheduledTask",
        );
        try {
          batch.track(
            params.appScheduler.register(pluginId, taskId, (context) =>
              batch.invoke(() => handler(context)),
            ),
          );
        } catch (error) {
          throw new PluginRegistrationError(
            "registerScheduledTask",
            error instanceof Error ? error.message : String(error),
          );
        }
      });
    },
    registerFormValidator(name, validator) {
      if (
        typeof name !== "string" ||
        !name.trim() ||
        typeof validator !== "function"
      )
        throw new PluginRegistrationError(
          "registerFormValidator",
          "expected a name and validator function",
        );
      batch.stage(() => {
        batch.track(
          rpcRegistry.registerFormValidator(pluginId, name, async (request) => {
            const session = await store.getSession(request.sessionId);
            if (!session) throw new Error("Form provider is not active");
            const runnable = params.pluginRegistry
              ? runnablePluginIds(session.activePlugins, params.pluginRegistry)
              : session.activePlugins;
            if (!runnable.includes(pluginId))
              throw new Error("Form provider is not active");
            if (
              pluginTrust === "community" &&
              !(await params.isCommunityServerCodeApproved?.(
                request.sessionId,
                pluginId,
              ))
            ) {
              throw new Error("Form provider requires server-code approval");
            }
            // The validator's answer is shown to the player, so it gets the
            // session's language and the plugin's own translations for it.
            const messages = pluginMessagesFor(
              params.pluginRegistry?.get(pluginId)?.messages,
              session.locale,
            );
            const refusal = await batch.invoke(() =>
              validator(
                Object.freeze(structuredClone(request.values)),
                structuredClone(request.data),
                Object.freeze({
                  locale: session.locale,
                  ...(messages ? { messages } : {}),
                }),
              ),
            );
            return normalizeFormRefusal(refusal);
          }),
        );
      });
    },
    registerWires(wires) {
      batch.stage(() => {
        if (!wires || typeof wires !== "object" || Array.isArray(wires)) {
          throw new PluginRegistrationError(
            "registerWires",
            "expected { image?, speech?, transcription?, music?, text? }",
          );
        }
        registerNamespaced(
          pluginId,
          wires,
          (dispose) => batch.track(dispose),
          (fn) => batch.invoke(fn),
          pluginTrust === "builtin",
        );
      });
    },
    registerProviderSources(sources) {
      batch.stage(() => {
        if (!params.providerSources) {
          throw new PluginRegistrationError(
            "registerProviderSources",
            "ProviderSourceHost is unavailable",
          );
        }
        if (!Array.isArray(sources)) {
          throw new PluginRegistrationError(
            "registerProviderSources",
            "expected an array of provider source definitions",
          );
        }
        for (const source of sources) {
          if (!source || typeof source !== "object") {
            throw new PluginRegistrationError(
              "registerProviderSources",
              "expected provider source object",
            );
          }
          parseIdWithSchema(
            providerSourceIdSchema,
            source.id,
            "registerProviderSources",
          );
          if (typeof source.resolve !== "function") {
            throw new PluginRegistrationError(
              "registerProviderSources",
              `provider source "${source.id}" must implement resolve()`,
            );
          }
          for (const optionalMethod of [
            "refresh",
            "listAccounts",
            "listModels",
            "getUsage",
            "classifyError",
          ] as const) {
            const candidate = source[optionalMethod];
            if (candidate !== undefined && typeof candidate !== "function") {
              throw new PluginRegistrationError(
                "registerProviderSources",
                `provider source "${source.id}" field "${optionalMethod}" must be a function`,
              );
            }
          }
          try {
            batch.track(
              params.providerSources.register(pluginId, {
                id: source.id,
                resolve: (req, ctx) =>
                  batch.invoke(() => source.resolve(req, ctx)),
                ...(source.refresh
                  ? {
                      refresh: (req, ctx) =>
                        batch.invoke(() => source.refresh!(req, ctx)),
                    }
                  : {}),
                ...(source.listAccounts
                  ? {
                      listAccounts: (ctx) =>
                        batch.invoke(() => source.listAccounts!(ctx)),
                    }
                  : {}),
                ...(source.listModels
                  ? {
                      listModels: (req, ctx) =>
                        batch.invoke(() => source.listModels!(req, ctx)),
                    }
                  : {}),
                ...(source.getUsage
                  ? {
                      getUsage: (req, ctx) =>
                        batch.invoke(() => source.getUsage!(req, ctx)),
                    }
                  : {}),
                ...(source.classifyError
                  ? {
                      classifyError: (err) => {
                        const release = batch.retain();
                        try {
                          return source.classifyError!(err);
                        } finally {
                          release();
                        }
                      },
                    }
                  : {}),
              }),
            );
          } catch (error) {
            throw new PluginRegistrationError(
              "registerProviderSources",
              error instanceof Error ? error.message : String(error),
            );
          }
        }
      });
    },
  };
}
