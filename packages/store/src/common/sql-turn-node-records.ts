import { asc, eq } from "drizzle-orm";
import type { Column, Table } from "drizzle-orm";
import type { InsertValueBuilders } from "./insert-values.js";
import type { JsonReader } from "./mappers.js";
import type { SqlRunner } from "./sql-runner.js";
import type { TurnNodeRecord, DataStore } from "../types.js";
import { SessionRecordScopeConflictError } from "../errors.js";

type TurnNodesTable = Table & {
  id: Column;
  sessionId: Column;
  createdAt: Column;
};

interface TurnNodeRow {
  id: string;
  sessionId: string;
  parentNodeId: string | null;
  activeChildId: string | null;
  turnId: string;
  turnIds: unknown;
  logicalTurn: number;
  seq: number;
  label: string | null;
  inputSummary: unknown;
  checkpointKind: string;
  baseNodeId: string;
  depthFromBase: number;
  statePayload: unknown;
  tailDelta: unknown;
  messagesAdded: unknown;
  turnMessagesAdded: unknown;
  playerInputsAdded: unknown;
  interactionRecordsAdded: unknown;
  mediaRefIds: unknown;
  capturedThroughWriteSeq: number;
  createdAt: string;
}

export interface SqlTurnNodeDeps {
  readonly runner: SqlRunner;
  readonly json: JsonReader;
  readonly values: Pick<InsertValueBuilders, "turnNodeInsert" | "turnNodeUpdate">;
  readonly table: TurnNodesTable;
}

function toRecord(row: TurnNodeRow, json: JsonReader): TurnNodeRecord {
  return {
    id: row.id,
    sessionId: row.sessionId,
    parentNodeId: row.parentNodeId,
    activeChildId: row.activeChildId,
    turnId: row.turnId,
    turnIds: json.readRequired(row.turnIds) as readonly string[],
    logicalTurn: row.logicalTurn,
    seq: row.seq,
    ...(row.label !== null ? { label: row.label } : {}),
    ...(json.read(row.inputSummary) !== undefined
      ? {
          inputSummary: json.read(
            row.inputSummary,
          ) as TurnNodeRecord["inputSummary"],
        }
      : {}),
    checkpointKind: row.checkpointKind as TurnNodeRecord["checkpointKind"],
    baseNodeId: row.baseNodeId,
    depthFromBase: row.depthFromBase,
    statePayload: json.readRequired(row.statePayload),
    ...(json.read(row.tailDelta) !== undefined
      ? { tailDelta: json.read(row.tailDelta) }
      : {}),
    messagesAdded: json.readRequired(row.messagesAdded) as readonly unknown[],
    turnMessagesAdded: json.readRequired(row.turnMessagesAdded) as readonly unknown[],
    playerInputsAdded: json.readRequired(row.playerInputsAdded) as readonly unknown[],
    interactionRecordsAdded: json.readRequired(row.interactionRecordsAdded) as readonly unknown[],
    mediaRefIds: json.readRequired(row.mediaRefIds) as readonly string[],
    capturedThroughWriteSeq: row.capturedThroughWriteSeq,
    createdAt: row.createdAt,
  };
}

export type SqlTurnNodeRecords = Pick<
  DataStore,
  "saveTurnNode" | "getTurnNode" | "listTurnNodes" | "deleteTurnNode"
>;

export function createSqlTurnNodeRecords(
  deps: SqlTurnNodeDeps,
): SqlTurnNodeRecords {
  const { runner, json, values, table } = deps;
  return {
    async saveTurnNode(record) {
      await runner.insert(table, values.turnNodeInsert(record), {
        target: table.id,
        set: values.turnNodeUpdate(record),
        setWhere: eq(table.sessionId, record.sessionId),
        errorOnSkipped: new SessionRecordScopeConflictError(
          "turn_node",
          record.id,
        ),
      });
    },
    async getTurnNode(id) {
      const row = await runner.selectFirst<TurnNodeRow>(table, {
        where: eq(table.id, id),
      });
      return row ? toRecord(row, json) : null;
    },
    async listTurnNodes(sessionId) {
      const rows = await runner.select<TurnNodeRow>(table, {
        where: eq(table.sessionId, sessionId),
        orderBy: [asc(table.createdAt)],
      });
      return rows.map((row) => toRecord(row, json));
    },
    async deleteTurnNode(id) {
      await runner.delete(table, eq(table.id, id));
    },
  };
}
