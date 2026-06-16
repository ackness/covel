/**
 * Backend-agnostic canonical row→record mappers for the snapshot domain
 * (snapshots and suspensions).
 */

import type {
  SnapshotKind,
  SnapshotPayload,
  SnapshotRecord,
  SuspensionRecord,
} from "../../types.js";
import type { JsonReader } from "./json-reader.js";

export interface SnapshotRow {
  id: string;
  sessionId: string;
  turnId: string;
  kind: string;
  parentId: string | null;
  payload: unknown;
  createdAt: string;
}

export interface SuspensionRow {
  id: string;
  sessionId: string;
  turnId: string;
  runtimeId: string;
  pluginId: string;
  reason: string;
  resumeSchema: unknown;
  pendingContinuation: unknown;
  createdAt: string;
  resolvedAt: string | null;
}

export function toSnapshotRecord(
  row: SnapshotRow,
  json: JsonReader,
): SnapshotRecord {
  return {
    id: row.id,
    sessionId: row.sessionId,
    turnId: row.turnId,
    kind: row.kind as SnapshotKind,
    parentId: row.parentId ?? undefined,
    payload: (json.readRequired(row.payload) ?? {}) as SnapshotPayload,
    createdAt: row.createdAt,
  };
}

export function toSuspensionRecord(
  row: SuspensionRow,
  json: JsonReader,
): SuspensionRecord {
  return {
    id: row.id,
    sessionId: row.sessionId,
    turnId: row.turnId,
    runtimeId: row.runtimeId,
    pluginId: row.pluginId,
    reason: row.reason,
    resumeSchema: json.readRequired(row.resumeSchema),
    pendingContinuation: (json.readRequired(row.pendingContinuation) ??
      {}) as SuspensionRecord["pendingContinuation"],
    createdAt: row.createdAt,
    resolvedAt: row.resolvedAt ?? undefined,
  };
}
