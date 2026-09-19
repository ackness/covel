import { randomUUID } from "node:crypto";
import type { Context } from "hono";
import { errorBody, okBody } from "../../../api-error.js";
import {
  isWorldDeleting,
  readWorldDeletion,
  WORLD_DELETION_KEY,
  WORLD_DELETION_LEASE_MS,
  worldOperationLockId,
  type WorldDeletion,
} from "../../../world-lifecycle.js";
import { decodePluginUserSettingsHeader } from "../plugin-user-settings.js";
import { deleteSessionWithLifecycle } from "../session/delete-route.js";
import {
  deleteWorldPackage,
  resolveGeneratedWorldPackage,
  WorldPackageResolutionError,
} from "./file-package.js";
import { checkWorldWriteAccess } from "./world-write-guard.js";

export async function deleteWorldWithLifecycle(c: Context): Promise<Response> {
  const denied = checkWorldWriteAccess(c);
  if (denied) return denied;
  const settings = decodePluginUserSettingsHeader(
    c.req.header("X-Plugin-User-Settings"),
  );
  if (!settings.ok) {
    return c.json(
      errorBody(settings.error, { code: settings.code }),
      settings.status,
    );
  }
  const store = c.get("store");
  const lock = c.get("sessionLock");
  const id = c.req.param("id")!;
  const key = worldOperationLockId(id);
  const nonce = randomUUID();
  const markRetryable = async (): Promise<void> => {
    try {
      await lock.withLock(key, async () => {
        const live = await store.getWorld(id);
        const deletion = live && readWorldDeletion(live);
        if (!live || deletion?.nonce !== nonce) return;
        await store.upsertWorld({
          ...live,
          metadata: {
            ...live.metadata,
            [WORLD_DELETION_KEY]: { ...deletion, retryable: true },
          },
        });
      });
    } catch {
      console.warn("[worlds] failed to mark deletion retryable", {
        worldId: id,
      });
    }
  };
  let prepared: { deletion: WorldDeletion } | Response;
  try {
    prepared = await lock.withLock(key, async () => {
      const world = await store.getWorld(id);
      if (!world)
        return c.json(
          errorBody("World not found", { code: "world_not_found" }),
          404,
        );
      if (world.metadata?.source === "file") {
        return c.json(errorBody("Built-in worlds cannot be deleted"), 403);
      }
      if (isWorldDeleting(world)) {
        const previous = readWorldDeletion(world);
        if (
          previous &&
          !previous.retryable &&
          Date.now() - Date.parse(previous.startedAt) <= WORLD_DELETION_LEASE_MS
        ) {
          return c.json(
            errorBody("World deletion is already in progress", {
              code: "world_deleting",
            }),
            409,
          );
        }
      }
      // Resolve the package before deleting any saves. A missing/ambiguous binding
      // cannot authorize a partial cascade. Resolve it again at the final removal.
      if (world.metadata?.source === "generated-file") {
        try {
          await resolveGeneratedWorldPackage(world, c.get("worldsDirs") ?? []);
        } catch (error) {
          if (!(error instanceof WorldPackageResolutionError)) throw error;
          return c.json(
            errorBody(error.message, { code: "world_package_unresolved" }),
            409,
          );
        }
      }
      const deletion: WorldDeletion = {
        nonce,
        startedAt: new Date().toISOString(),
      };
      await store.upsertWorld({
        ...world,
        metadata: { ...world.metadata, [WORLD_DELETION_KEY]: deletion },
      });
      return { deletion };
    });
  } catch (error) {
    await markRetryable();
    throw error;
  }
  if (prepared instanceof Response) return prepared;

  const changed = () =>
    c.json(
      errorBody("World deletion generation changed", {
        code: "world_deletion_changed",
      }),
      409,
    );
  let completed = false;
  try {
    const sessions = (await store.listSessions()).filter(
      (session) => session.worldId === id,
    );
    for (const session of sessions) {
      const owned = await lock.withLock(key, async () => {
        const live = await store.getWorld(id);
        if (!live || readWorldDeletion(live)?.nonce !== prepared.deletion.nonce)
          return false;
        await store.upsertWorld({
          ...live,
          metadata: {
            ...live.metadata,
            [WORLD_DELETION_KEY]: {
              ...prepared.deletion,
              startedAt: new Date().toISOString(),
            },
          },
        });
        return true;
      });
      if (!owned) return changed();
      // Do not hold the world lock across session locks, drains or hooks.
      const response = await deleteSessionWithLifecycle(c, session.id, session);
      if (!response.ok && response.status !== 404) return response;
    }

    const result = await lock.withLock(key, async () => {
      const live = await store.getWorld(id);
      if (!live || readWorldDeletion(live)?.nonce !== prepared.deletion.nonce)
        return changed();
      if (
        (await store.listSessions()).some((session) => session.worldId === id)
      ) {
        return c.json(
          errorBody("World still has sessions; retry deletion", {
            code: "world_delete_incomplete",
          }),
          409,
        );
      }
      const removeRecord = async () => {
        try {
          await store.deleteWorld(id);
        } catch (error) {
          // A lost acknowledgement after commit must not restore the package.
          if (await store.getWorld(id)) throw error;
        }
      };
      if (live.metadata?.source === "generated-file") {
        let worldPath: string;
        try {
          worldPath = await resolveGeneratedWorldPackage(
            live,
            c.get("worldsDirs") ?? [],
          );
        } catch (error) {
          if (!(error instanceof WorldPackageResolutionError)) throw error;
          return c.json(
            errorBody(error.message, { code: "world_package_unresolved" }),
            409,
          );
        }
        await deleteWorldPackage(worldPath, removeRecord);
      } else {
        await removeRecord();
      }
      return c.json(okBody());
    });
    completed = result.ok;
    return result;
  } finally {
    if (!completed) {
      await markRetryable();
    }
  }
}
