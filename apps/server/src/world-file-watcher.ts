/**
 * World file watcher — monitors worlds/ directory for changes and
 * updates the DataStore + notifies active sessions via EventBus.
 *
 * Uses Node.js native `fs.watch` with recursive mode.
 * Changes are debounced per world directory to handle multi-file writes.
 */

import { watch, type FSWatcher } from "node:fs";
import { realpath } from "node:fs/promises";
import path from "node:path";
import type { DataStore } from "@covel/store";
import type { EventBus } from "@covel/events";
import {
  loadSingleWorld,
  preserveWorldProvenance,
} from "./world-seed-loader.js";
import { resolveWorldRoot } from "./world-data/session-import/utils.js";

export interface WorldFileWatcher {
  start(): void;
  /** Stop intake and wait for reloads already using the store/event bus. */
  stop(): Promise<void>;
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
   * Re-read a world package and update the store if dimensions changed.
   */
  async function reloadWorld(directoryName: string) {
    const worldDir = path.join(worldsDir, directoryName);

    try {
      const newRecord = await loadSingleWorld(worldDir);
      if (!newRecord) return;

      const worldId = newRecord.id;
      const activeRoot = await resolveWorldRoot(worldId, worldsDirs);
      if (activeRoot !== (await realpath(worldDir))) return;
      const existing = await store.getWorld(worldId);
      if (!existing) return;

      // Compare dimensions (serialized JSON comparison)
      const oldDims = (existing.metadata as Record<string, unknown> | undefined)
        ?.dimensions;
      const newDims = (
        newRecord.metadata as Record<string, unknown> | undefined
      )?.dimensions;
      const oldJson = JSON.stringify(oldDims ?? {});
      const newJson = JSON.stringify(newDims ?? {});

      if (oldJson === newJson) return;

      // Find which dimension keys changed
      const oldMap = (oldDims ?? {}) as Record<string, unknown>;
      const newMap = (newDims ?? {}) as Record<string, unknown>;
      const allKeys = new Set([...Object.keys(oldMap), ...Object.keys(newMap)]);
      const changedKeys: string[] = [];
      for (const key of allKeys) {
        if (JSON.stringify(oldMap[key]) !== JSON.stringify(newMap[key])) {
          changedKeys.push(key);
        }
      }

      // Package reloads cannot change the world's storage ownership.
      await store.upsertWorld({
        ...preserveWorldProvenance(newRecord, existing),
        updatedAt: new Date().toISOString(),
      });

      console.log(
        `[world-watcher] ${worldId}: dimensions updated (${changedKeys.join(", ")})`,
      );

      // Notify active sessions using this world
      await notifySessions(worldId, changedKeys);
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
            const segments = filename.split(path.sep);
            if (segments.length < 1) return;

            const directoryName = segments[0];
            if (directoryName.startsWith(".")) return;
            // Ignore dotfiles and non-yaml/md files
            const ext = path.extname(filename).toLowerCase();
            if (ext !== ".yaml" && ext !== ".yml" && ext !== ".md") return;

            scheduleReload(directoryName);
          },
        );

        console.log(`[world-watcher] Watching ${worldsDir} for changes`);
      } catch (err) {
        console.warn(`[world-watcher] Failed to start file watcher:`, err);
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
