/**
 * POST /worlds/:id/restore-package — replace a package world's record with
 * what its package files hold now.
 *
 * The record is the world. After the player edits a package world in the app,
 * reloads, the startup seed and updates keep the edited record; this is the
 * one way back to the package version.
 */

import { Hono } from "hono";
import type { WorldRecord } from "@covel/store";
import { errorBody } from "../../../api-error.js";
import { resolveWorldRoot } from "../../../world-data/session-import/utils.js";
import { describeWorldChange } from "../../../world-file-watcher.js";
import {
  loadSingleWorld,
  preserveWorldProvenance,
} from "../../../world-seed-loader.js";
import { withWritableWorld } from "./mutation-guard.js";
import {
  type WorldEnv,
  isPackageWorld,
  notifyWorldDimensionsChanged,
} from "./shared.js";
import { checkWorldWriteAccess } from "./world-write-guard.js";

export const worldRestorePackageRoutes = new Hono<WorldEnv>();

worldRestorePackageRoutes.post("/:id/restore-package", async (c) => {
  const denied = checkWorldWriteAccess(c);
  if (denied) return denied;
  const store = c.get("store");
  const id = c.req.param("id");
  return withWritableWorld(c, id, async (existing) => {
    if (!isPackageWorld(existing))
      return c.json(
        errorBody("This world was not installed from a package", {
          code: "world_not_from_package",
        }),
        409,
      );
    const root = await resolveWorldRoot(id, c.get("worldsDirs") ?? []);
    if (!root)
      return c.json(
        errorBody("The package of this world is not in a worlds directory", {
          code: "world_package_missing",
        }),
        409,
      );
    const loaded = await loadSingleWorld(root);
    if (!loaded || loaded.id !== id)
      return c.json(
        errorBody(
          "The package of this world cannot be read; the edited world stays",
          { code: "world_package_invalid" },
        ),
        422,
      );
    const { packageModified: _edited, ...metadata } = existing.metadata ?? {};
    const now = new Date().toISOString();
    const restored: WorldRecord = {
      ...preserveWorldProvenance(loaded, { ...existing, metadata }),
      updatedAt: now,
    };
    const change = describeWorldChange(existing, restored);
    await store.upsertWorld(restored);
    await notifyWorldDimensionsChanged(
      store,
      c.get("eventBus"),
      id,
      change.dimensionKeys,
      now,
    );
    return c.json(restored);
  });
});
