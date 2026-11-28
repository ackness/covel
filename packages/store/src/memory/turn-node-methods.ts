import { sortByCursorAsc } from "../common/pagination.js";
import { requireTurnNodeCheckpointKind } from "../common/sql-turn-node-records.js";
import type { TurnNodeRecord } from "../types.js";
import type { MemoryState, MemoryStoreMethods } from "./memory-types.js";
import { assertSessionRecordScope } from "./session-record-scope.js";

/** Normalize optional/nullable fields so MemoryStore matches SQL round-trips. */
function normalizeTurnNode(record: TurnNodeRecord): TurnNodeRecord {
  requireTurnNodeCheckpointKind(record.checkpointKind);
  const {
    label,
    inputSummary,
    tailDelta,
    parentNodeId,
    activeChildId,
    ...rest
  } = record;
  return {
    ...rest,
    parentNodeId: parentNodeId ?? null,
    activeChildId: activeChildId ?? null,
    ...(label != null ? { label } : {}),
    ...(inputSummary != null ? { inputSummary } : {}),
    ...(tailDelta != null ? { tailDelta } : {}),
  };
}

export function createTurnNodeMethods(state: MemoryState): MemoryStoreMethods {
  return {
    async saveTurnNode(record: TurnNodeRecord) {
      assertSessionRecordScope(
        "turn_node",
        record,
        state.turnNodes.get(record.id)?.sessionId,
      );
      state.turnNodes.set(
        record.id,
        structuredClone(normalizeTurnNode(record)),
      );
    },
    async getTurnNode(id: string) {
      const record = state.turnNodes.get(id);
      return record ? structuredClone(record) : null;
    },
    async listTurnNodes(sessionId: string) {
      return sortByCursorAsc(
        [...state.turnNodes.values()].filter(
          (record) => record.sessionId === sessionId,
        ),
      ).map((record) => structuredClone(record));
    },
    async deleteTurnNode(id: string) {
      state.turnNodes.delete(id);
    },
  };
}
