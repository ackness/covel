/**
 * Backend-agnostic canonical row→record mappers for the session domain.
 */

import type { SessionStatus, SetupRuntimeState } from "@covel/shared";
import type { SessionRecord } from "../../types.js";
import type { JsonReader } from "./json-reader.js";

export interface SessionRow {
  id: string;
  worldId: string | null;
  status: string;
  locale: string;
  activePlugins: unknown;
  metadata: unknown;
  createdAt: string;
  updatedAt: string;
  embeddingModelId: number | null;
  embeddingLockedAt: string | null;
  runtimeModelOverrides: unknown;
  phase: string;
  completedPlayerTurns: number;
  setupRuntimes: unknown;
}

const SESSION_STATUSES = new Set<SessionStatus>(["active", "paused", "ended"]);

function requireSessionStatus(value: string): SessionStatus {
  if (!SESSION_STATUSES.has(value as SessionStatus)) {
    throw new Error(`Invalid session status: ${value}`);
  }
  return value as SessionStatus;
}

function requireSessionPhase(value: string): SessionRecord["phase"] {
  if (value !== "setup" && value !== "playing") {
    throw new Error(`Invalid session phase: ${value}`);
  }
  return value;
}

function requireActivePlugins(value: unknown): readonly string[] {
  if (
    !Array.isArray(value) ||
    !value.every((item) => typeof item === "string")
  ) {
    throw new Error("Invalid session activePlugins: expected string array");
  }
  return value;
}

function requireSetupRuntimes(
  value: unknown,
): Readonly<Record<string, SetupRuntimeState>> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Invalid session setupRuntimes: expected object");
  }
  return value as Readonly<Record<string, SetupRuntimeState>>;
}

export function toSessionRecord(
  row: SessionRow,
  json: JsonReader,
): SessionRecord {
  const metadata = json.read(row.metadata) as
    Record<string, unknown> | undefined;
  const overrides = json.read(row.runtimeModelOverrides) as
    Record<string, string> | undefined;
  const activePlugins = requireActivePlugins(
    json.readRequired(row.activePlugins),
  );
  const setupRuntimes = requireSetupRuntimes(
    json.readRequired(row.setupRuntimes),
  );
  if (
    !Number.isSafeInteger(row.completedPlayerTurns) ||
    row.completedPlayerTurns < 0
  ) {
    throw new Error(
      `Invalid completedPlayerTurns: ${row.completedPlayerTurns}`,
    );
  }
  return {
    id: row.id,
    worldId: row.worldId ?? undefined,
    status: requireSessionStatus(row.status),
    locale: row.locale,
    activePlugins,
    metadata,
    ...(typeof metadata?.presetId === "string"
      ? { presetId: metadata.presetId }
      : {}),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    ...(row.embeddingModelId != null
      ? { embeddingModelId: row.embeddingModelId }
      : {}),
    ...(row.embeddingLockedAt != null
      ? { embeddingLockedAt: row.embeddingLockedAt }
      : {}),
    ...(overrides && Object.keys(overrides).length > 0
      ? { runtimeModelOverrides: overrides }
      : {}),
    phase: requireSessionPhase(row.phase),
    completedPlayerTurns: row.completedPlayerTurns,
    setupRuntimes,
  };
}
