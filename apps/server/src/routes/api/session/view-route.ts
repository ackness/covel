import type { Hono } from "hono";
import { buildSessionSnapshot } from "@covel/runtime";
import { errorBody } from "../../../api-error.js";
import {
  resolveSessionParam,
  SESSION_NOT_FOUND_CODE,
} from "./session-guard.js";
import {
  buildSnapshotPluginList,
  findWorldDataProviderPluginId,
} from "./plugins.js";
import type { SessionRouteEnv } from "./route-env.js";

export function registerSessionViewRoute(routes: Hono<SessionRouteEnv>): void {
  routes.get("/:id/view", async (c) => {
    const store = c.get("store");
    const pluginRegistry = c.get("pluginRegistry");
    const id = c.req.param("id");
    const guard = await resolveSessionParam(c);
    if (!guard.ok) return guard.response;

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

    const view = {
      ...snapshot,
      plugins: buildSnapshotPluginList(
        pluginRegistry,
        new Set(currentSession.activePlugins),
      ),
    };
    const worldDataPluginId = findWorldDataProviderPluginId(
      currentSession.activePlugins,
      pluginRegistry,
    );
    if (worldDataPluginId) {
      try {
        const schemaRecord = await store.getPluginData(
          id,
          worldDataPluginId,
          "schema",
          "character-attributes",
        );
        if (schemaRecord?.value) {
          return c.json({ ...view, characterSchema: schemaRecord.value });
        }
      } catch {
        // Optional schema discovery must not prevent session restore.
      }
    }
    return c.json(view);
  });
}
