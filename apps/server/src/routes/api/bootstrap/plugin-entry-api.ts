import { fetchWithRetry, validateBaseUrlForPlugin } from "@covel/ai-provider";
import { getPluginTrustInfo } from "@covel/plugin-loader";
import type {
  PluginAPI,
  PluginToolkit,
  PluginEntryScope,
} from "@covel/runtime";
import type { RpcTrustLevel } from "@covel/shared";
import { validatePluginHookRegistration } from "@covel/runtime";
import {
  shortId,
  shortIdBatch,
  tool,
  withPendingProposals,
} from "@covel/tools";
import { z } from "zod";
import type { BootstrapPluginEntriesParams } from "./plugin-entry.js";
import { registerNamespaced } from "./plugin-wires.js";
import { PluginRegistrationError } from "./plugin-registration-error.js";

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
): PluginAPI {
  const {
    discoveryMap,
    store,
    tools,
    hookPipeline,
    rpcRegistry,
    isCommunityHookApproved,
  } = params;
  const http = { fetchWithRetry, validateBaseUrl: validateBaseUrlForPlugin };
  let hookSeq = 0;
  const trustInfo = getPluginTrustInfo(
    pluginId,
    discoveryMap.get(pluginId)?.source,
  );
  const pluginTrust: RpcTrustLevel = trustInfo.source;

  // Registration has no session authority. Reads are injected per tool call.
  const toolkit: PluginToolkit = {
    tool,
    z,
    shortId,
    shortIdBatch,
    withPendingProposals,
  };

  return {
    pluginId,
    provideExtension,
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
          batch.track(
            params.services!.register(pluginId, {
              ...definition,
              handler: (input, context) =>
                batch.invoke(() => definition.handler(input, context)),
            }),
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
            if (!session?.activePlugins.includes(pluginId))
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
            return batch.invoke(() =>
              validator(
                Object.freeze(structuredClone(request.values)),
                structuredClone(request.data),
              ),
            );
          }),
        );
      });
    },
    registerWires(wires) {
      batch.stage(() => {
        if (!wires || typeof wires !== "object" || Array.isArray(wires)) {
          throw new PluginRegistrationError(
            "registerWires",
            "expected { image?, speech?, transcription? }",
          );
        }
        registerNamespaced(
          pluginId,
          wires,
          (dispose) => batch.track(dispose),
          (fn) => batch.invoke(fn),
        );
      });
    },
  };
}
