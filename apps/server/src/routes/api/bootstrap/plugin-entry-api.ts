import {
  getPluginTrustInfo,
  type PluginEntryDefinition,
} from "@covel/plugin-loader";
import type {
  PluginAPI,
  PluginToolkit,
  PluginEntryScope,
} from "@covel/runtime";
import {
  pluginMessagesFor,
  rpcActionNameSchema,
  type RpcTrustLevel,
} from "@covel/shared";
import {
  normalizeFormRefusal,
  validatePluginHookRegistration,
} from "@covel/runtime";
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
  const trustInfo = getPluginTrustInfo(
    pluginId,
    discoveryMap.get(pluginId)?.source,
  );
  const pluginTrust: RpcTrustLevel = trustInfo.source;
  const isCommunity = pluginTrust === "community";
  const http = createEntryHttp(pluginId, isCommunity, httpPermissions);
  // A service or extension provider's code sends its own requests, so a
  // community provider reaches what its package declares, whoever calls it.
  const ownUtils = <C extends { utils?: unknown; signal: AbortSignal }>(
    context: C,
  ): C =>
    isCommunity && context.utils
      ? { ...context, utils: withCallSignal(http, context.signal) }
      : context;

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
        batch.track(
          hookPipeline.register({
            id: `${pluginId}:${event}:entry#${hookSeq}`,
            event,
            pluginId,
            handler: sessionGuardedHandler,
            ...(options?.match ? { match: options.match } : {}),
            ...(typeof options?.timeoutMs === "number"
              ? { timeoutMs: options.timeoutMs }
              : {}),
            ...(options?.enforce ? { enforce: options.enforce } : {}),
          }),
        );
      });
    },
    registerRpc(action, handler, options) {
      batch.stage(() => {
        validateOptions(rpcOptionsSchema, "registerRpc", options);
        if (
          typeof action !== "string" ||
          !action.trim() ||
          typeof handler !== "function"
        ) {
          throw new PluginRegistrationError(
            "registerRpc",
            "expected a non-empty action name and a handler function",
          );
        }
        const name = rpcActionNameSchema.safeParse(action);
        if (!name.success) {
          throw new PluginRegistrationError(
            "registerRpc",
            name.error.issues.map((issue) => issue.message).join("; "),
          );
        }
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
  };
}
