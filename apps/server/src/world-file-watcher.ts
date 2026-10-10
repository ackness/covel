/**
 * World file watcher — monitors worlds/ directory for changes and
 * updates the DataStore + notifies active sessions via EventBus.
 *
 * Uses Node.js native `fs.watch` with recursive mode.
 * Changes are debounced per world directory to handle multi-file writes.
 *
 * What a reload reaches: the world record in the store (lore and its
 * editions, name, summary, tags, plugin policy, dimensions, data summaries).
 * A new session reads the package from disk, and a running session reads the
 * record's lore on its next turn unless the session holds a lore override.
 * Nothing already written for a session (imported characters, lorebook
 * entries, dimension values, committed state) is touched.
 */

import type { SessionLock } from "./lib/session-lock.js";
import { isWorldDeleting, worldOperationLockId } from "./world-lifecycle.js";
import { resolveContainedPath } from "./world-data/safe-path.js";
import { watch, type FSWatcher } from "node:fs";
import { WORLD_LOCALIZED_TEXT_KEY } from "@covel/shared";
import { realpath } from "node:fs/promises";
import path from "node:path";
import type { DataStore, WorldRecord } from "@covel/store";
import type { EventBus } from "@covel/events";
import {
  loadSingleWorld,
  preserveWorldProvenance,
} from "./world-seed-loader.js";
import {
  readWorldManifest,
  resolveWorldRoot,
} from "./world-data/session-import/utils.js";

export interface WorldFileWatcher {
  start(): void;
  /** Stop intake and wait for reloads already using the store/event bus. */
  stop(): Promise<void>;
}

/** A change to a media file is served from disk; it needs no reload. */
const IGNORED_EXTENSIONS = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".webp",
  ".gif",
  ".mp3",
  ".wav",
  ".ogg",
  ".mp4",
  ".swp",
  ".tmp",
]);

/** Whether a path inside a worlds directory can change what a reload reads. */
export function isWorldSourceFile(filename: string): boolean {
  const segments = filename.split(path.sep);
  // Dotfiles and editor scratch files (`.WORLD.md.swp`, `WORLD.md~`).
  if (segments.some((segment) => segment.startsWith(".") || !segment))
    return false;
  if (filename.endsWith("~")) return false;
  return !IGNORED_EXTENSIONS.has(path.extname(filename).toLowerCase());
}

const same = (a: unknown, b: unknown) =>
  JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

export interface WorldReloadChange {
  /** What differs, in the words an author uses. Empty when nothing does. */
  readonly areas: string[];
  /** Keys of the dimensions that differ. */
  readonly dimensionKeys: string[];
}

/** Which parts of a world record a reload would change. */
export function describeWorldChange(
  before: WorldRecord,
  after: WorldRecord,
): WorldReloadChange {
  const oldMeta = (before.metadata ?? {}) as Record<string, unknown>;
  const newMeta = (after.metadata ?? {}) as Record<string, unknown>;
  const text = (meta: Record<string, unknown>) =>
    (meta[WORLD_LOCALIZED_TEXT_KEY] ?? {}) as Record<string, unknown>;
  const { lore: oldLore, ...oldText } = text(oldMeta);
  const { lore: newLore, ...newText } = text(newMeta);

  const areas: string[] = [];
  if (!same(before.lore, after.lore) || !same(oldLore, newLore))
    areas.push("lore");
  if (
    !same(
      [before.name, before.description, before.tags, before.locale, oldText],
      [after.name, after.description, after.tags, after.locale, newText],
    )
  )
    areas.push("name and summary");

  const oldDims = (oldMeta.dimensions ?? {}) as Record<string, unknown>;
  const newDims = (newMeta.dimensions ?? {}) as Record<string, unknown>;
  const dimensionKeys = [
    ...new Set([...Object.keys(oldDims), ...Object.keys(newDims)]),
  ].filter((key) => !same(oldDims[key], newDims[key]));
  if (dimensionKeys.length > 0) areas.push("dimensions");

  if (
    !same(
      [oldMeta.pluginPolicy, oldMeta.pluginSettings],
      [newMeta.pluginPolicy, newMeta.pluginSettings],
    )
  )
    areas.push("plugin policy and settings");

  const handled = new Set([
    "dimensions",
    "pluginPolicy",
    "pluginSettings",
    WORLD_LOCALIZED_TEXT_KEY,
  ]);
  const otherKeys = new Set([...Object.keys(oldMeta), ...Object.keys(newMeta)]);
  for (const key of otherKeys)
    if (!handled.has(key) && !same(oldMeta[key], newMeta[key])) {
      areas.push("world data and settings");
      break;
    }
  return { areas, dimensionKeys };
}

/**
 * Create a file watcher that monitors world directories for changes.
 *
 * When a dimension file or world.yaml changes:
 * 1. Re-reads the affected world package
 * 2. Compares with current store state
 * 3. Updates the store if dimensions changed
 * 4. Emits SSE events to active sessions using that world
 */
export function createWorldFileWatcher(
  worldsDir: string,
  store: DataStore,
  eventBus: EventBus,
  sessionLock: SessionLock,
  worldsDirs: readonly string[] = [worldsDir],
): WorldFileWatcher {
  let watcher: FSWatcher | null = null;

  // Debounce timers per physical directory; manifest ids can differ.
  const debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();
  const reloads = new Map<string, Promise<void>>();
  const DEBOUNCE_MS = 500;

  /**
   * Handle a file change event for a specific world.
   * Debounced to avoid processing partial writes.
   */
  function scheduleReload(directoryName: string) {
    if (!watcher) return;
    const existing = debounceTimers.get(directoryName);
    if (existing) clearTimeout(existing);

    debounceTimers.set(
      directoryName,
      setTimeout(() => {
        debounceTimers.delete(directoryName);
        // A slow earlier read must not overwrite a newer package revision.
        const previous = reloads.get(directoryName) ?? Promise.resolve();
        const reload = previous.then(() => reloadWorld(directoryName));
        reloads.set(directoryName, reload);
        void reload.then(() => {
          if (reloads.get(directoryName) === reload)
            reloads.delete(directoryName);
        });
      }, DEBOUNCE_MS),
    );
  }

  /**
   * Re-read a world package and update the store when anything the record
   * holds changed.
   */
  async function reloadWorld(directoryName: string) {
    const worldDir = path.join(worldsDir, directoryName);

    try {
      if (!(await resolveContainedPath(worldDir, "world.yaml"))) return;
      const { id: worldId } = await readWorldManifest(worldDir);
      if (!worldId) return;
      const outcome = await sessionLock.withLock(
        worldOperationLockId(worldId),
        async () => {
          const newRecord = await loadSingleWorld(worldDir);
          if (!newRecord || newRecord.id !== worldId) {
            console.warn(
              `[world-watcher] ${worldId}: ${directoryName} could not be read as a world (see the message above); the version loaded before stays in use`,
            );
            return;
          }
          const activeRoot = await resolveWorldRoot(worldId, worldsDirs);
          if (activeRoot !== (await realpath(worldDir))) return;
          const existing = await store.getWorld(worldId);
          if (!existing || isWorldDeleting(existing)) return;

          // Package reloads cannot change the world's storage ownership.
          const next = preserveWorldProvenance(newRecord, existing);
          if (next === existing) {
            console.log(
              `[world-watcher] ${worldId}: files changed, but the world was edited in the app; the edited copy stays`,
            );
            return;
          }
          const change = describeWorldChange(existing, next);
          if (change.areas.length === 0) return;
          await store.upsertWorld({
            ...next,
            updatedAt: new Date().toISOString(),
          });
          return change;
        },
      );
      if (!outcome) return;
      console.log(
        `[world-watcher] ${worldId}: reloaded ${outcome.areas.join(", ")}. New sessions use it; a running session reads the lore on its next turn unless it has its own lore override, and what it already imported (characters, lorebook entries, dimension values) stays as it is.`,
      );

      // Dimension values are read by running sessions: tell them.
      if (outcome.dimensionKeys.length > 0)
        await notifySessions(worldId, outcome.dimensionKeys);
    } catch (err) {
      console.warn(
        `[world-watcher] Failed to reload world directory ${directoryName}:`,
        err,
      );
    }
  }

  /**
   * Emit SSE events to all active sessions that use the changed world.
   * Note: listSessions() returns all sessions; filtering is done in-memory.
   * For large deployments, consider adding a store.listSessionsByWorldId() method.
   */
  async function notifySessions(worldId: string, changedKeys: string[]) {
    try {
      const sessions = await store.listSessions();
      const affected = sessions.filter((s) => s.worldId === worldId);

      const now = new Date().toISOString();

      for (const session of affected) {
        eventBus.emit({
          id: crypto.randomUUID(),
          type: "event",
          topic: "system",
          payload: {
            _subTopic: "system",
            _subType: "world.dimensions.changed",
            worldId,
            changedKeys,
          },
          sessionId: session.id,
          timestamp: now,
        });
      }

      if (affected.length > 0) {
        console.log(
          `[world-watcher] Notified ${affected.length} session(s) for world ${worldId}`,
        );
      }
    } catch (err) {
      console.warn(
        `[world-watcher] Failed to notify sessions for ${worldId}:`,
        err,
      );
    }
  }

  return {
    start() {
      if (watcher) return;
      try {
        watcher = watch(
          worldsDir,
          { recursive: true },
          (_eventType, filename) => {
            if (!filename) return;

            // The first segment locates the package, not its logical world id.
            const directoryName = filename.split(path.sep)[0];
            if (!directoryName || directoryName.startsWith(".")) return;
            if (!isWorldSourceFile(filename)) return;

            scheduleReload(directoryName);
          },
        );

        console.log(`[world-watcher] Watching ${worldsDir} for changes`);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") {
          console.warn(
            `[world-watcher] Not watching ${worldsDir}: directory does not exist`,
          );
        } else {
          console.warn(`[world-watcher] Failed to start file watcher:`, err);
        }
      }
    },

    async stop() {
      if (watcher) {
        watcher.close();
        watcher = null;
      }
      for (const timer of debounceTimers.values()) {
        clearTimeout(timer);
      }
      debounceTimers.clear();
      await Promise.allSettled(reloads.values());
    },
  };
}
