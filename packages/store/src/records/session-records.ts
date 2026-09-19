/**
 * Session record type and partial-update semantics.
 */

import type { SessionStatus, SetupRuntimeState } from "@covel/shared";

export interface SessionRecord {
  readonly id: string;
  readonly worldId?: string;
  /** Lifecycle flag — `active` / `paused` / `ended`. */
  readonly status: SessionStatus;
  readonly locale: string;
  readonly activePlugins: readonly string[];
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
  /** FK to vector_models.id; null = RAG disabled */
  readonly embeddingModelId?: number | null;
  /** ISO 8601 timestamp; null = not locked */
  readonly embeddingLockedAt?: string | null;
  /**
   * Per-runtime model slot overrides. Maps runtime ID
   * (`pluginId` or `pluginId/runtimeName`) → slot name from `llm.toml`.
   * Empty/undefined means no overrides — slot resolution falls back to
   * `manifest.model` then `"default"`.
   */
  readonly runtimeModelOverrides?: Readonly<Record<string, string>>;
  /** `setup` while setup runtimes are unresolved, then `playing`. */
  readonly phase: "setup" | "playing";
  /** Count of completed player turns in the main loop. */
  readonly completedPlayerTurns: number;
  /**
   * Per-runtime setup-band resolution state, keyed by runtimeId. Mirrors the
   * `SetupAttemptRecord` log into a compact map the scheduler can read without
   * scanning attempts. Replaced wholesale on write (no deep merge).
   */
  readonly setupRuntimes: Readonly<Record<string, SetupRuntimeState>>;
}

export function mergeSessionPatch(
  existing: SessionRecord,
  patch: Partial<
    Pick<
      SessionRecord,
      | "status"
      | "activePlugins"
      | "locale"
      | "updatedAt"
      | "metadata"
      | "embeddingModelId"
      | "embeddingLockedAt"
      | "runtimeModelOverrides"
      | "phase"
      | "completedPlayerTurns"
      | "setupRuntimes"
    >
  >,
): SessionRecord {
  const metadata: Record<string, unknown> = {
    ...existing.metadata,
    ...patch.metadata,
  };
  return {
    ...existing,
    ...patch,
    metadata: Object.keys(metadata).length > 0 ? metadata : undefined,
  };
}
