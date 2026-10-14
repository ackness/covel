/**
 * MemoryStore's write order: the JS mirror of the triggers in
 * `common/write-order-ddl.ts`. Every turn message and every change of a
 * lorebook entry, character or plugin data row takes the next number of its
 * session; `recordChanges` keeps the latest change of each record.
 */

import { lorebookOwnerKey } from "../common/lorebook-owner.js";
import type {
  LorebookOwner,
  RecordChange,
  RecordChangeQuery,
} from "../types.js";
import type { MemoryState } from "./memory-types.js";

type ChangeIdentity =
  | {
      readonly kind: "lorebook";
      readonly owner: LorebookOwner;
      readonly id: string;
    }
  | { readonly kind: "character"; readonly id: string }
  | {
      readonly kind: "plugin_data";
      readonly pluginId: string;
      readonly namespace: string;
      readonly key: string;
    };

/** The next write number of a session. */
export function nextSessionWrite(
  state: MemoryState,
  sessionId: string,
): number {
  const value = (state.sessionWriteCounters.get(sessionId)?.value ?? 0) + 1;
  state.sessionWriteCounters.set(sessionId, { sessionId, value });
  return value;
}

function changeKey(sessionId: string, change: ChangeIdentity): string {
  const parts =
    change.kind === "lorebook"
      ? [lorebookOwnerKey(change.owner), change.id]
      : change.kind === "character"
        ? [change.id]
        : [change.pluginId, change.namespace, change.key];
  return JSON.stringify([sessionId, change.kind, ...parts]);
}

/** Record that a record of a session was inserted, updated or deleted. */
export function recordChange(
  state: MemoryState,
  sessionId: string,
  change: ChangeIdentity,
): void {
  const seq = nextSessionWrite(state, sessionId);
  state.recordChanges.set(changeKey(sessionId, change), {
    sessionId,
    change: { ...change, seq } as RecordChange,
  });
}

export function listRecordChanges(
  state: MemoryState,
  sessionId: string,
  query: RecordChangeQuery,
): RecordChange[] {
  if (query.limit <= 0) return [];
  const { after, through, pluginData } = query;
  const rows: RecordChange[] = [];
  for (const row of state.recordChanges.values()) {
    const change = row.change;
    if (row.sessionId !== sessionId) continue;
    if (after !== null && change.seq <= after) continue;
    if (through !== undefined && change.seq > through) continue;
    if (
      pluginData &&
      (change.kind !== "plugin_data" ||
        change.pluginId !== pluginData.pluginId ||
        change.namespace !== pluginData.namespace)
    )
      continue;
    rows.push(change);
  }
  return rows.sort((a, b) => a.seq - b.seq).slice(0, query.limit);
}
