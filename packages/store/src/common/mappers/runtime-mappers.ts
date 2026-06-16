/**
 * Backend-agnostic canonical row→record mappers for the runtime domain
 * (turn results, runtime results, tool calls, runtime outputs, interactions).
 */

import type {
  InteractionRecordRow,
  RuntimeOutputRecord,
  RuntimeResultRecord,
  ToolCallRecordRow,
  TurnResultRecord,
} from "../../types.js";
import type { JsonReader } from "./json-reader.js";

export interface TurnResultRow {
  id: string;
  sessionId: string;
  turnId: string;
  runtimeResults: unknown;
  conflicts: unknown;
  auditResult: unknown;
  durationMs: number;
  createdAt: string;
}

export interface RuntimeResultRow {
  id: string;
  sessionId: string;
  turnId: string;
  pluginId: string;
  runtimeId: string;
  status: string;
  output: unknown;
  toolCalls: unknown;
  durationMs: number;
  tokenUsage: unknown;
  error: string | null;
  createdAt: string;
}

export interface ToolCallRow {
  id: string;
  sessionId: string;
  turnId: string;
  toolName: string;
  pluginId: string;
  runtimeId: string;
  input: unknown;
  output: unknown;
  durationMs: number;
  approvalStatus: string;
  createdAt: string;
}

export interface RuntimeOutputRow {
  id: string;
  sessionId: string;
  turnId: string;
  runtimeResultId: string | null;
  pluginId: string;
  runtimeId: string;
  timestamp: string;
  results: unknown;
  metaData: unknown;
  createdAt: string;
}

export interface InteractionRow {
  id: string;
  sessionId: string;
  turnId: string | null;
  timestamp: string;
  source: string;
  channel: string;
  type: string;
  targetPluginId: string | null;
  targetRuntimeId: string | null;
  payload: unknown;
  metaData: unknown;
  createdAt: string;
}

export function toTurnResultRecord(
  row: TurnResultRow,
  json: JsonReader,
): TurnResultRecord {
  return {
    id: row.id,
    sessionId: row.sessionId,
    turnId: row.turnId,
    runtimeResults: json.readRequired(row.runtimeResults),
    conflicts: json.read(row.conflicts),
    auditResult: json.read(row.auditResult),
    durationMs: row.durationMs,
    createdAt: row.createdAt,
  };
}

export function toRuntimeResultRecord(
  row: RuntimeResultRow,
  json: JsonReader,
): RuntimeResultRecord {
  return {
    id: row.id,
    sessionId: row.sessionId,
    turnId: row.turnId,
    pluginId: row.pluginId,
    runtimeId: row.runtimeId,
    status: row.status,
    output: json.read(row.output),
    toolCalls: json.read(row.toolCalls),
    durationMs: row.durationMs,
    tokenUsage: json.read(row.tokenUsage),
    error: row.error ?? undefined,
    createdAt: row.createdAt,
  };
}

export function toToolCallRecord(
  row: ToolCallRow,
  json: JsonReader,
): ToolCallRecordRow {
  return {
    id: row.id,
    sessionId: row.sessionId,
    turnId: row.turnId,
    toolName: row.toolName,
    pluginId: row.pluginId,
    runtimeId: row.runtimeId,
    input: json.read(row.input),
    output: json.read(row.output),
    durationMs: row.durationMs,
    approvalStatus: row.approvalStatus,
    createdAt: row.createdAt,
  };
}

export function toRuntimeOutputRecord(
  row: RuntimeOutputRow,
  json: JsonReader,
): RuntimeOutputRecord {
  return {
    id: row.id,
    sessionId: row.sessionId,
    turnId: row.turnId,
    runtimeResultId: row.runtimeResultId ?? undefined,
    pluginId: row.pluginId,
    runtimeId: row.runtimeId,
    timestamp: row.timestamp,
    results: json.readRequired(row.results),
    metaData: json.readRequired(row.metaData),
    createdAt: row.createdAt,
  };
}

export function toInteractionRecordRow(
  row: InteractionRow,
  json: JsonReader,
): InteractionRecordRow {
  return {
    id: row.id,
    sessionId: row.sessionId,
    turnId: row.turnId ?? undefined,
    timestamp: row.timestamp,
    source: row.source,
    channel: row.channel,
    type: row.type,
    targetPluginId: row.targetPluginId ?? undefined,
    targetRuntimeId: row.targetRuntimeId ?? undefined,
    payload: json.readRequired(row.payload),
    metaData: json.read(row.metaData),
    createdAt: row.createdAt,
  };
}
