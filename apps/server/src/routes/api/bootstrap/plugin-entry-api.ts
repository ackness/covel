import { fetchWithRetry, validateBaseUrlForPlugin } from "@covel/ai-provider";
import { getPluginTrustInfo } from "@covel/plugin-loader";
import type { PluginAPI, PluginToolkit } from "@covel/runtime";
import { HOOK_EVENTS, type RpcTrustLevel } from "@covel/shared";
import {
  shortId,
  shortIdBatch,
  tool,
  withPendingProposals,
  type ToolModule,
} from "@covel/tools";
import { z } from "zod";
import type { BootstrapPluginEntriesParams } from "./plugin-entry.js";
import type { EntryRegistrationBatch } from "./entry-registration-batch.js";
import { registerNamespaced } from "./plugin-wires.js";
import { PluginRegistrationError } from "./plugin-registration-error.js";

const HOOK_EVENT_SET: ReadonlySet<string> = new Set(HOOK_EVENTS);

function isToolModule(value: unknown): value is ToolModule {
  return (
    Boolean(value) &&
    typeof value === "object" &&
    (value as Record<string, unknown>)._type === "covel-tool"
  );
}

export function buildEntryApi(
  params: BootstrapPluginEntriesParams,
  pluginId: string,
  batch: EntryRegistrationBatch,
): PluginAPI {
  const {
    discoveryMap,
    store,
    toolMap,
    localToolNames,
    pluginToolAccess,
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
    toolkit,
    http,
    registerService(definition) {
      if (!params.services)
        throw new Error("Plugin service registry is unavailable");
      batch.stage(() =>
        batch.track(params.services!.register(pluginId, definition)),
      );
    },
    registerTool(toolModule) {
      batch.stage(() => {
        if (!isToolModule(toolModule)) {
          throw new PluginRegistrationError(
            "registerTool",
            "expected a ToolModule built with covel.toolkit.tool()",
          );
        }
        // Reject collisions: a duplicate name would silently replace the
        // existing implementation globally — for a builtin name, `findTool`
        // resolves via builtinToolNames first and every runtime would get
        // the replacement, bypassing the plugin access boundary.
        if (toolMap.has(toolModule.name)) {
          throw new PluginRegistrationError(
            "registerTool",
            `tool "${toolModule.name}" collides with an existing tool; use a plugin-prefixed name`,
          );
        }
        toolMap.set(toolModule.name, toolModule);
        const wasLocal = localToolNames.has(toolModule.name);
        localToolNames.add(toolModule.name);
        const hadAccessSet = pluginToolAccess.has(pluginId);
        let allowed = pluginToolAccess.get(pluginId);
        if (!allowed) {
          allowed = new Set();
          pluginToolAccess.set(pluginId, allowed);
        }
        const hadAccess = allowed.has(toolModule.name);
        allowed.add(toolModule.name);
        const access = allowed;
        batch.track(() => {
          if (toolMap.get(toolModule.name) !== toolModule) return;
          toolMap.delete(toolModule.name);
          if (!wasLocal) localToolNames.delete(toolModule.name);
          if (!hadAccess) access.delete(toolModule.name);
          if (
            !hadAccessSet &&
            access.size === 0 &&
            pluginToolAccess.get(pluginId) === access
          ) {
            pluginToolAccess.delete(pluginId);
          }
        });
      });
    },
    on(event, handler, options) {
      batch.stage(() => {
        if (!HOOK_EVENT_SET.has(event)) {
          throw new PluginRegistrationError(
            "on",
            `unknown hook event "${event}"`,
          );
        }
        if (typeof handler !== "function") {
          throw new PluginRegistrationError(
            "on",
            `hook "${event}" expects a handler function`,
          );
        }
        hookSeq += 1;
        const sessionGuardedHandler: typeof handler = async (ctx, payload) => {
          if (
            pluginTrust === "community" &&
            !(await isCommunityHookApproved?.(ctx.sessionId, pluginId))
          ) {
            return { action: "continue" };
          }
          ctx.signal?.throwIfAborted();
          return handler(ctx, payload);
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
            handler,
            options ?? {},
            pluginTrust,
          ),
        );
      });
    },
    registerFormValidator(name, validator) {
      if (!name || typeof validator !== "function")
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
            return validator(
              Object.freeze(structuredClone(request.values)),
              structuredClone(request.data),
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
        registerNamespaced(pluginId, wires, (dispose) => batch.track(dispose));
      });
    },
  };
}
