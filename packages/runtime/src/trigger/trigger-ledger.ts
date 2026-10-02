/**
 * Per-runtime trigger ledger.
 *
 * `maxTriggerCount` needs how often a runtime has run and `cooldownTurns` how
 * many player turns ago it last ran. Both live in one kernel-owned plugin-data
 * row per runtime, written by the commit that ran it, so a rolled-back
 * execution never counts and the conversation journal no longer needs a row
 * per execution. Snapshots and forks carry the rows with the rest of the
 * session's plugin data.
 */

import type {
  DataStore,
  PluginDataRecord,
  StoreTransaction,
} from "@covel/store";

const TRIGGER_LEDGER_OWNER = "__kernel:triggers";
const TRIGGER_LEDGER_NAMESPACE = "runtimes";

/**
 * Turns-since value for a runtime that has never run. Large enough to satisfy
 * any `cooldownTurns` / `turnInterval` gate.
 */
export const NEVER_TRIGGERED_SENTINEL = 999;

export interface RuntimeTriggerRecord {
  readonly count: number;
  /** `completedPlayerTurns` after the commit that last ran the runtime. */
  readonly completedPlayerTurns: number;
}

function parseRecord(value: unknown): RuntimeTriggerRecord | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return undefined;
  const { count, completedPlayerTurns } = value as Record<string, unknown>;
  return Number.isSafeInteger(count) &&
    Number.isSafeInteger(completedPlayerTurns)
    ? {
        count: count as number,
        completedPlayerTurns: completedPlayerTurns as number,
      }
    : undefined;
}

async function listLedgerRows(
  store: Pick<DataStore, "listPluginData">,
  sessionId: string,
): Promise<readonly PluginDataRecord[]> {
  return store.listPluginData(
    sessionId,
    TRIGGER_LEDGER_OWNER,
    TRIGGER_LEDGER_NAMESPACE,
  );
}

export async function readRuntimeTriggerLedger(
  store: Pick<DataStore, "listPluginData">,
  sessionId: string,
): Promise<ReadonlyMap<string, RuntimeTriggerRecord>> {
  const ledger = new Map<string, RuntimeTriggerRecord>();
  for (const row of await listLedgerRows(store, sessionId)) {
    const record = parseRecord(row.value);
    if (record) ledger.set(row.key, record);
  }
  return ledger;
}

/**
 * Player turns since each runtime last ran, seen from an execution at
 * `playerTurn` (committed player turns, plus one when this execution adds a
 * player message). Runtimes that never ran are absent.
 */
export function turnsSinceLastTrigger(
  ledger: ReadonlyMap<string, RuntimeTriggerRecord>,
  playerTurn: number,
): ReadonlyMap<string, number> {
  return new Map(
    [...ledger].map(([runtimeId, record]) => [
      runtimeId,
      Math.max(0, playerTurn - record.completedPlayerTurns),
    ]),
  );
}

/**
 * Count each run in `runtimeIds` (a runtime may appear more than once). Call
 * inside the finalize transaction after the session-clock write, so the
 * recorded turn includes this execution's own player turn.
 */
export async function recordRuntimeTriggersTx(
  tx: StoreTransaction,
  args: {
    readonly sessionId: string;
    readonly runtimeIds: readonly string[];
    readonly now: string;
  },
): Promise<void> {
  const { sessionId, runtimeIds, now } = args;
  if (runtimeIds.length === 0) return;
  const session = await tx.getSession(sessionId);
  if (!session) return;
  const runs = new Map<string, number>();
  for (const runtimeId of runtimeIds)
    runs.set(runtimeId, (runs.get(runtimeId) ?? 0) + 1);
  const existing = new Map(
    (await listLedgerRows(tx, sessionId)).map((row) => [row.key, row]),
  );
  await tx.setPluginDataBatch(
    [...runs].map(([runtimeId, count]): PluginDataRecord => {
      const previous = existing.get(runtimeId);
      return {
        id: `${sessionId}:${TRIGGER_LEDGER_OWNER}:${TRIGGER_LEDGER_NAMESPACE}:${runtimeId}`,
        sessionId,
        pluginId: TRIGGER_LEDGER_OWNER,
        namespace: TRIGGER_LEDGER_NAMESPACE,
        key: runtimeId,
        value: {
          count: (parseRecord(previous?.value)?.count ?? 0) + count,
          completedPlayerTurns: session.completedPlayerTurns,
        },
        createdAt: previous?.createdAt ?? now,
        updatedAt: now,
      };
    }),
  );
}
