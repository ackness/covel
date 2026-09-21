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
  pluginRelPath: string,
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
          console.warn(
            `[plugin-entry] ${pluginRelPath}: registerTool() expects a ToolModule built with covel.toolkit.tool() — skipping`,
          );
          return;
        }
        // Reject collisions: a duplicate name would silently replace the
        // existing implementation globally — for a builtin name, `findTool`
        // resolves via builtinToolNames first and every runtime would get
        // the replacement, bypassing the plugin access boundary.
        if (toolMap.has(toolModule.name)) {
          console.warn(
            `[plugin-entry] ${pluginRelPath}: registerTool("${toolModule.name}") collides with an existing tool — skipping`,
          );
          return;
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
          console.warn(
            `[plugin-entry] ${pluginRelPath}: unknown hook event "${event}" — skipping`,
          );
          return;
        }
        if (typeof handler !== "function") {
          console.warn(
            `[plugin-entry] ${pluginRelPath}: on("${event}") expects a handler function — skipping`,
          );
          return;
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
        if (typeof handler !== "function") {
          console.warn(
            `[plugin-entry] ${pluginRelPath}: registerRpc("${action}") expects a handler function — skipping`,
          );
          return;
        }
        try {
          batch.track(
            rpcRegistry.registerPluginHandler(
              pluginId,
              action,
              handler,
              options ?? {},
              pluginTrust,
            ),
          );
        } catch (err) {
          console.warn(
            `[plugin-entry] ${pluginRelPath}: registerRpc("${action}") failed —`,
            err instanceof Error ? err.message : err,
          );
        }
      });
    },
    registerFormValidator(name, validator) {
      if (!name || typeof validator !== "function")
        throw new Error("Invalid form validator registration");
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
        if (!wires || typeof wires !== "object") {
          console.warn(
            `[plugin-entry] ${pluginRelPath}: registerWires() expects { image?, speech?, transcription? } — skipping`,
          );
          return;
        }
        registerNamespaced(pluginId, pluginRelPath, wires, (dispose) =>
          batch.track(dispose),
        );
      });
    },
  };
}
