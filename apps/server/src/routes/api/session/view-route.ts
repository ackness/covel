import type { Hono } from "hono";
import { buildSessionSnapshot, createWorldModelView } from "@covel/runtime";
import { pluginRuntimeManifests } from "@covel/plugin-loader";
import { sessionWorldContextV1 } from "@covel/shared";
import { errorBody } from "../../../api-error.js";
import {
  resolveSessionParam,
  SESSION_NOT_FOUND_CODE,
} from "./session-guard.js";
import { buildSnapshotPluginList } from "./plugins.js";
import type { SessionRouteEnv } from "./route-env.js";
import { getSessionExecutionStatus } from "../actions/execution-recovery.js";

export function registerSessionViewRoute(routes: Hono<SessionRouteEnv>): void {
  routes.get("/:id/view", async (c) => {
    const store = c.get("store");
    const pluginRegistry = c.get("pluginRegistry");
    const id = c.req.param("id");
    const guard = await resolveSessionParam(c);
    if (!guard.ok) return guard.response;

    const execution = await getSessionExecutionStatus(
      store,
      id,
      c.get("sessionLock"),
    );
    const snapshot = await buildSessionSnapshot(store, id);
    if (!snapshot) {
      return c.json(
        errorBody(`Session not found: ${id}`, {
          code: SESSION_NOT_FOUND_CODE,
        }),
        404,
      );
    }
    const currentSession = await store.getSession(id);
    if (!currentSession) {
      return c.json(
        errorBody(`Session not found: ${id}`, {
          code: SESSION_NOT_FOUND_CODE,
        }),
        404,
      );
    }

    const extensionHost = c.get("pluginExtensions");
    const context =
      snapshot.dimensionProviderPluginId && extensionHost
        ? await extensionHost
            .createExecution({
              sessionId: id,
              locale: currentSession.locale,
              signal: c.req.raw.signal,
              runtimeIdentities: [...pluginRegistry.getAll()].flatMap(
                ([pluginId, entry]) =>
                  currentSession.activePlugins.includes(pluginId)
                    ? pluginRuntimeManifests(entry).map(
                        (parsed) => parsed.manifest,
                      )
                    : [],
              ),
              world: await createWorldModelView(store, id),
              readPluginData: (pluginId, namespace) =>
                store.listPluginData(id, pluginId, namespace),
            })
            .run(sessionWorldContextV1, {})
        : undefined;
    if (
      snapshot.dimensionProviderPluginId &&
      context?.dimensionProviderPluginId !== snapshot.dimensionProviderPluginId
    )
      throw new Error("Authoritative dimension context unavailable");
    const view = {
      ...snapshot,
      ...(context?.dimensionRecovery
        ? { dimensionRecovery: context.dimensionRecovery }
        : {}),
      execution,
      plugins: buildSnapshotPluginList(
        pluginRegistry,
        new Set(currentSession.activePlugins),
      ),
    };
    return c.json({
      ...view,
      characterSchema: await store.getCharacterSchema(id),
    });
  });
}
