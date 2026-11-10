import { Hono } from "hono";
import { mediaImageFlowV1, type MediaImageFlow } from "@covel/shared";
import {
  createWorldModelView,
  type HookScope,
  type PluginExtensionHost,
} from "@covel/runtime";
import type { PluginRegistry } from "@covel/plugin-loader";
import type { DataStore } from "@covel/store";
import { resolveSessionParam } from "./session/session-guard.js";
import { loadSessionPluginSettings } from "./session/hook-scope.js";
export async function resolveMediaImageFlow(args: {
  readonly store: DataStore;
  readonly host: PluginExtensionHost | undefined;
  readonly pluginRegistry: Pick<PluginRegistry, "get" | "getAll"> | undefined;
  readonly sessionId: string;
  /**
   * The resolved settings of the execution being committed, so the provider
   * reads the player's values. Without them (the standalone route, which no
   * player settings reach) the session's defaults and world presets apply.
   */
  readonly settings?: HookScope["settings"];
  readonly signal?: AbortSignal;
}): Promise<MediaImageFlow | undefined> {
  const { store, host, sessionId } = args;
  if (!host) return undefined;
  const session = await store.getSession(sessionId);
  if (!session) return undefined;
  return host
    .createExecution({
      sessionId,
      locale: session.locale ?? "zh-CN",
      settings:
        args.settings ??
        (await loadSessionPluginSettings({
          store,
          pluginRegistry: args.pluginRegistry,
          session,
        })),
      signal: args.signal ?? new AbortController().signal,
      world: await createWorldModelView(store, sessionId),
      readPluginData: (pluginId, namespace) =>
        store.listPluginData(sessionId, pluginId, namespace),
    })
    .run(mediaImageFlowV1, {});
}
export const mediaImageFlowRoutes = new Hono();
mediaImageFlowRoutes.get("/:id/media/image-flow", async (c) => {
  const guard = await resolveSessionParam(c);
  if (!guard.ok) return guard.response;
  const flow = await resolveMediaImageFlow({
    store: c.get("store"),
    host: c.get("pluginExtensions"),
    pluginRegistry: c.get("pluginRegistry"),
    sessionId: guard.session.id,
    signal: c.req.raw.signal,
  });
  return c.json({ flow: flow ?? null });
});
