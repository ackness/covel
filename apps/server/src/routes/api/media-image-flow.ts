import { Hono } from "hono";
import { mediaImageFlowV1, type MediaImageFlow } from "@covel/shared";
import type { PluginExtensionHost } from "@covel/runtime";
import type { DataStore } from "@covel/store";
import { resolveSessionParam } from "./session/session-guard.js";
export async function resolveMediaImageFlow(
  store: DataStore,
  host: PluginExtensionHost | undefined,
  sessionId: string,
  signal = new AbortController().signal,
): Promise<MediaImageFlow | undefined> {
  if (!host) return undefined;
  const session = await store.getSession(sessionId);
  if (!session) return undefined;
  return host
    .createExecution({
      sessionId,
      locale: session.locale ?? "zh-CN",
      signal,
      pluginData: await store.listPluginDataSessionScope(sessionId),
    })
    .run(mediaImageFlowV1, {});
}
export const mediaImageFlowRoutes = new Hono();
mediaImageFlowRoutes.get("/:id/media/image-flow", async (c) => {
  const guard = await resolveSessionParam(c);
  if (!guard.ok) return guard.response;
  const flow = await resolveMediaImageFlow(
    c.get("store"),
    c.get("pluginExtensions"),
    guard.session.id,
    c.req.raw.signal,
  );
  return c.json({ flow: flow ?? null });
});
