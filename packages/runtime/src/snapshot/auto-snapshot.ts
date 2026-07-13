import type { EventBus } from "@covel/events";
import type { DataStore, SnapshotRecord } from "@covel/store";
import { emitSubEvent } from "../turn-executor/turn-runtime-helpers.js";
import { buildSnapshotPayload } from "./snapshot-payload-builder.js";

export interface SaveAutoSnapshotOptions {
  readonly store: DataStore;
  readonly sessionId: string;
  readonly turnId: string;
  readonly createdAt?: string;
  readonly eventBus?: EventBus;
}

/**
 * Persist the post-commit snapshot for one turn.
 *
 * Callers must invoke this only after every proposal and lifecycle update for
 * the turn has committed, while still holding the session's mutation lock.
 */
export async function saveAutoSnapshot(
  options: SaveAutoSnapshotOptions,
): Promise<SnapshotRecord> {
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
