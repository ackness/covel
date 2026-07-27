/**
 * Session record type and normalisers.
 *
 * Split out of `../types.ts` by domain; re-exported there for compatibility.
 */

import type { SessionStatus, SetupRuntimeState } from "@covel/shared";

export interface SessionRecord {
  readonly id: string;
  readonly worldId?: string;
  /** Lifecycle flag — `active` / `paused` / `ended`. */
  readonly status: SessionStatus;
  /**
   * LEGACY band selector. The kernel no longer writes it — API responses and
   * snapshots derive it at read time from {@link phase} /
   * {@link completedPlayerTurns} via `deriveLegacyClockForSession`. The column
   * is frozen for old-kernel / rollback reads. (The numeric priority bands it
   * once selected — 0-99 vs 100-1000 — no longer exist; scheduling is by named
   * stage plus a dependency DAG.)
   */
  readonly turnCount: number;
  /**
   * LEGACY completion list, likewise derived at read time (the `done` entries
   * of {@link setupRuntimes}, sorted). {@link setupRuntimes} is the business
   * truth; this column is frozen for rollback reads.
   */
  readonly preGameCompleted: readonly string[];
  readonly locale: string;
  readonly activePlugins: readonly string[];
  readonly presetId?: string;
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
  /**
   * Setup/main-loop band selector for the scheduling redesign. `setup` while
   * any setup-band runtime is unresolved, `playing` once the barrier is
   * crossed. Optional — absent on rows written before this field existed.
   */
  readonly phase?: "setup" | "playing";
  /**
   * Count of completed player turns in the main loop. Distinct from
   * {@link turnCount} (the legacy band selector); populated by the kernel
   * wiring wave. Optional — absent on legacy rows.
   */
  readonly completedPlayerTurns?: number;
  /**
   * Per-runtime setup-band resolution state, keyed by runtimeId. Mirrors the
   * `SetupAttemptRecord` log into a compact map the scheduler can read without
   * scanning attempts. Replaced wholesale on write (no deep merge). Optional —
   * absent on legacy rows.
   */
  readonly setupRuntimes?: Readonly<Record<string, SetupRuntimeState>>;
}

export function normalizeSessionRecord(session: SessionRecord): SessionRecord {
  const metadataPresetId = session.metadata?.presetId;
  if (session.presetId === undefined) {
    return typeof metadataPresetId === "string"
      ? { ...session, presetId: metadataPresetId }
      : session;
  }
  return {
    ...session,
    metadata: {
      ...session.metadata,
      presetId: session.presetId,
    },
  };
}

export function mergeSessionPatch(
  existing: SessionRecord,
  patch: Partial<
    Pick<
      SessionRecord,
      | "status"
      | "turnCount"
      | "preGameCompleted"
      | "activePlugins"
      | "presetId"
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
  if ("presetId" in patch) {
    if (patch.presetId === undefined) {
      delete metadata.presetId;
    } else {
      metadata.presetId = patch.presetId;
    }
  }
  return normalizeSessionRecord({
    ...existing,
    ...patch,
    metadata: Object.keys(metadata).length > 0 ? metadata : undefined,
  });
}
