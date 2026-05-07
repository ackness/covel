/**
 * World file watcher — monitors worlds/ directory for changes and
 * updates the DataStore + notifies active sessions via EventBus.
 *
 * Uses Node.js native `fs.watch` with recursive mode (macOS/Windows).
 * Changes are debounced per world directory to handle multi-file writes.
 */

import { watch, type FSWatcher } from "node:fs";
import path from "node:path";
import type { DataStore } from "@covel/store";
import type { EventBus } from "@covel/events";
import { loadSingleWorld } from "./world-seed-loader.js";

export interface WorldFileWatcher {
  start(): void;
  stop(): void;
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
): WorldFileWatcher {
  let watcher: FSWatcher | null = null;

  // Debounce timers per worldId
  const debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();
  const DEBOUNCE_MS = 500;

  /**
   * Handle a file change event for a specific world.
   * Debounced to avoid processing partial writes.
   */
  function scheduleReload(worldId: string) {
    const existing = debounceTimers.get(worldId);
    if (existing) clearTimeout(existing);

    debounceTimers.set(
      worldId,
      setTimeout(() => {
        debounceTimers.delete(worldId);
        void reloadWorld(worldId);
      }, DEBOUNCE_MS),
    );
  }

  /**
   * Re-read a world package and update the store if dimensions changed.
   */
  async function reloadWorld(worldId: string) {
    const worldDir = path.join(worldsDir, worldId);

    try {
      const newRecord = await loadSingleWorld(worldDir);
      if (!newRecord) return;

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

      // Update store with new data, preserving existing timestamps
      await store.upsertWorld({
        ...newRecord,
        createdAt: existing.createdAt,
        updatedAt: new Date().toISOString(),
      });

      console.log(
        `[world-watcher] ${worldId}: dimensions updated (${changedKeys.join(", ")})`,
      );

      // Notify active sessions using this world
      await notifySessions(worldId, changedKeys);
    } catch (err) {
      console.warn(`[world-watcher] Failed to reload world ${worldId}:`, err);
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
      // fs.watch({ recursive: true }) is only supported on macOS and Windows.
      // On Linux (Docker/production), skip gracefully with a clear message.
      if (process.platform === "linux") {
        console.log(
          `[world-watcher] Skipped — recursive fs.watch not supported on Linux. Use POST /api/worlds/:id/dimensions/import for updates.`,
        );
        return;
      }

      try {
        watcher = watch(
          worldsDir,
          { recursive: true },
          (_eventType, filename) => {
            if (!filename) return;

            // Extract worldId from the file path (first path segment)
            const segments = filename.split(path.sep);
            if (segments.length < 1) return;

            const worldId = segments[0];
            // Ignore dotfiles and non-yaml/md files
            const ext = path.extname(filename).toLowerCase();
            if (ext !== ".yaml" && ext !== ".yml" && ext !== ".md") return;

            scheduleReload(worldId);
          },
        );

        console.log(`[world-watcher] Watching ${worldsDir} for changes`);
      } catch (err) {
        console.warn(`[world-watcher] Failed to start file watcher:`, err);
      }
    },

    stop() {
      if (watcher) {
        watcher.close();
        watcher = null;
      }
      for (const timer of debounceTimers.values()) {
        clearTimeout(timer);
      }
      debounceTimers.clear();
    },
  };
}
