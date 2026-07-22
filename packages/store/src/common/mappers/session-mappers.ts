/**
 * Backend-agnostic canonical row→record mappers for the session domain.
 */

import type { SessionStatus, SetupRuntimeState } from "@covel/shared";
import type { SessionRecord } from "../../types.js";
import type { JsonReader } from "./json-reader.js";

export interface SessionRow {
  id: string;
  worldId: string | null;
  status: string | null;
  turnCount: number;
  preGameCompleted: unknown;
  locale: string;
  activePlugins: unknown;
  metadata: unknown;
  createdAt: string;
  updatedAt: string;
  embeddingModelId: number | null;
  embeddingLockedAt: string | null;
  runtimeModelOverrides: unknown;
  phase: string | null;
  completedPlayerTurns: number | null;
  setupRuntimes: unknown;
}

export function toSessionRecord(
  row: SessionRow,
  json: JsonReader,
): SessionRecord {
  const metadata = json.read(row.metadata) as
    Record<string, unknown> | undefined;
  const overrides = json.read(row.runtimeModelOverrides) as
    Record<string, string> | undefined;
  const setupRuntimes = json.read(row.setupRuntimes) as
    Record<string, SetupRuntimeState> | undefined;
  return {
    id: row.id,
    worldId: row.worldId ?? undefined,
    status: (row.status ?? "active") as SessionStatus,
    turnCount: row.turnCount,
    preGameCompleted: (json.read(row.preGameCompleted) ??
      []) as readonly string[],
    locale: row.locale,
    activePlugins: (json.read(row.activePlugins) ?? []) as readonly string[],
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
    ...(row.phase != null ? { phase: row.phase as "setup" | "playing" } : {}),
    ...(row.completedPlayerTurns != null
      ? { completedPlayerTurns: row.completedPlayerTurns }
      : {}),
    ...(setupRuntimes && Object.keys(setupRuntimes).length > 0
      ? { setupRuntimes }
      : {}),
  };
}
