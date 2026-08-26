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

const SNAPSHOT_KINDS = new Set<SnapshotKind>(["auto", "manual", "fork"]);

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Invalid ${label}: expected object`);
  }
  return value as Record<string, unknown>;
}

function requireSnapshotKind(value: string): SnapshotKind {
  if (!SNAPSHOT_KINDS.has(value as SnapshotKind)) {
    throw new Error(`Invalid snapshot kind: ${value}`);
  }
  return value as SnapshotKind;
}

function requireSnapshotPayload(value: unknown): SnapshotPayload {
  const payload = requireRecord(value, "snapshot payload");
  if (payload.schemaVersion !== 3) {
    throw new Error(
      `Invalid snapshot payload schemaVersion: ${String(payload.schemaVersion)}`,
    );
  }
  requireRecord(payload.session, "snapshot session");
  return payload as unknown as SnapshotPayload;
}

function requirePendingContinuation(
  value: unknown,
): SuspensionRecord["pendingContinuation"] {
  const continuation = requireRecord(value, "suspension pendingContinuation");
  requireRecord(
    continuation.executionContext,
    "suspension pendingContinuation.executionContext",
  );
  return continuation as unknown as SuspensionRecord["pendingContinuation"];
}

export function toSnapshotRecord(
  row: SnapshotRow,
  json: JsonReader,
): SnapshotRecord {
  return {
    id: row.id,
    sessionId: row.sessionId,
    turnId: row.turnId,
    kind: requireSnapshotKind(row.kind),
    parentId: row.parentId ?? undefined,
    payload: requireSnapshotPayload(json.readRequired(row.payload)),
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
    pendingContinuation: requirePendingContinuation(
      json.readRequired(row.pendingContinuation),
    ),
    createdAt: row.createdAt,
    resolvedAt: row.resolvedAt ?? undefined,
  };
}
