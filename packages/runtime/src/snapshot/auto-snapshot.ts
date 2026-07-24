import type { EventBus } from "@covel/events";
import { deriveLegacyClockForSession, readEnvInt } from "@covel/shared";
import type { DataStore, SnapshotRecord } from "@covel/store";
import { emitSubEvent } from "../turn-executor/turn-runtime-helpers.js";
import { buildSnapshotPayload } from "./snapshot-payload-builder.js";

/**
 * Default auto-snapshot cadence in turns (env-overridable via
 * `COVEL_SNAPSHOT_INTERVAL_TURNS`). Building a snapshot payload full-reads the
 * session's message history and every session-scoped collection, so a snapshot
 * per turn is O(T²) over a session's lifetime — checkpoints every N turns keep
 * fork/restore working at a fraction of the cost (audit 2026-07-11 R-04).
 */
export const DEFAULT_AUTO_SNAPSHOT_INTERVAL_TURNS = 5;

export interface SaveAutoSnapshotOptions {
  readonly store: DataStore;
  readonly sessionId: string;
  readonly turnId: string;
  readonly createdAt?: string;
  readonly eventBus?: EventBus;
  /**
   * Checkpoint cadence: snapshot only when `session.turnCount` is a multiple
   * of this interval (turnCount <= 1 — pre-game and the first post-pre-game
   * turn — always snapshots). Defaults to `COVEL_SNAPSHOT_INTERVAL_TURNS`
   * (fallback {@link DEFAULT_AUTO_SNAPSHOT_INTERVAL_TURNS}); values < 1 clamp
   * to 1 (every turn).
   */
  readonly intervalTurns?: number;
  /**
   * Bypass the cadence gate. Used by paths whose snapshot is load-bearing
   * regardless of turn number (e.g. resume: a fork taken after a resume must
   * see the resumed runtime's writes).
   */
  readonly force?: boolean;
}

function resolveIntervalTurns(intervalTurns?: number): number {
  const interval =
    intervalTurns ??
    readEnvInt(
      "COVEL_SNAPSHOT_INTERVAL_TURNS",
      DEFAULT_AUTO_SNAPSHOT_INTERVAL_TURNS,
    );
  return interval >= 1 ? interval : 1;
}

/**
 * Persist the post-commit snapshot for one turn, throttled to checkpoint
 * cadence. Returns the saved record, or `null` when the turn is not a
 * checkpoint (no snapshot written, no event emitted).
 *
 * Callers must invoke this only after every proposal and lifecycle update for
 * the turn has committed, while still holding the session's mutation lock —
 * on the main action path that means after `advanceSessionTurnCount`, so the
 * cadence check sees the post-turn count.
 */
export async function saveAutoSnapshot(
  options: SaveAutoSnapshotOptions,
): Promise<SnapshotRecord | null> {
  if (!options.force) {
    const interval = resolveIntervalTurns(options.intervalTurns);
    if (interval > 1) {
      const session = await options.store.getSession(options.sessionId);
      // Derive the cadence turnCount from the clock — the column is no longer
      // written by the kernel.
      const turnCount = session
        ? deriveLegacyClockForSession(session).turnCount
        : 0;
      // turnCount <= 1 covers pre-game turns (0) and the turn that completes
      // pre-game (synced to 1 just before the snapshot), so a fork point
      // always exists once setup finishes.
      if (turnCount > 1 && turnCount % interval !== 0) return null;
    }
  }

  const payload = await buildSnapshotPayload(
    options.store,
    options.sessionId,
    options.turnId,
  );
  const snapshot: SnapshotRecord = {
    id: crypto.randomUUID(),
    sessionId: options.sessionId,
    turnId: options.turnId,
    kind: "auto",
    payload,
    createdAt: options.createdAt ?? new Date().toISOString(),
  };
  await options.store.saveSnapshot(snapshot);
  emitSubEvent(
    options.eventBus,
    "session",
    "state.snapshot.created",
    options.sessionId,
    {
      turnId: options.turnId,
      snapshotId: snapshot.id,
      kind: "auto",
    },
  );
  return snapshot;
}
