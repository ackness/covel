/**
 * Session lifecycle types — wire contract between server and any API client.
 * DB record `SessionRecord` in `@covel/store` is a superset with backend fields.
 */

import type { SetupRuntimeState } from "./runtime-lifecycle.js";

export type SessionStatus = "active" | "paused" | "ended";

export interface SessionEmbeddingInfo {
  readonly modelId: string;
  readonly provider: string;
  readonly modelName: string;
  readonly dim: number;
  readonly lockedAt: string | null;
}

export interface Session {
  readonly id: string;
  readonly worldId?: string;
  /** Lifecycle flag. `active` under normal play; `paused`/`ended` stops scheduling. */
  readonly status: SessionStatus;
  /**
   * Legacy main-loop progress field, derived at read time from `phase` and
   * `completedPlayerTurns`. The kernel no longer schedules by numeric bands.
   */
  readonly turnCount: number;
  /**
   * Legacy setup completion list, derived from the `done` entries in
   * `setupRuntimes`.
   */
  readonly preGameCompleted: readonly string[];
  /** Authoritative setup/main-loop scheduling phase. Optional on legacy rows. */
  readonly phase?: "setup" | "playing";
  /** Number of committed main-loop player turns. Optional on legacy rows. */
  readonly completedPlayerTurns?: number;
  /** Per-runtime setup lifecycle mirror, keyed by runtimeId. */
  readonly setupRuntimes?: Readonly<Record<string, SetupRuntimeState>>;
  readonly activePlugins: readonly string[];
  readonly locale: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  /**
   * FK to vector_models.id; null/undefined = RAG disabled for this session.
   * Set once at session creation, immutable for the session's lifetime.
   */
  readonly embeddingModelId?: number | null;
  /**
   * ISO 8601 timestamp marking when the embedding model was locked.
   * Null/undefined when no model is locked.
   */
  readonly embeddingLockedAt?: string | null;
  /**
   * Resolved embedding model identity (decorated by the API layer when
   * the session is locked). Absent when RAG is disabled for this session.
   */
  readonly embedding?: SessionEmbeddingInfo | null;
  /**
   * Per-runtime model slot overrides.
   *
   * `key` is a runtime ID (`pluginId` for single-runtime plugins, or
   * `pluginId/runtimeName` for multi-runtime plugins). `value` is a slot
   * name from `llm.toml` (e.g. `"default"`, `"fast"`, `"balance"`).
   *
   * The model-slot resolver consults this map first; if absent, falls back
   * to `manifest.model`, then to `"default"`. Provider/key configuration
   * stays in localStorage + `X-Provider-Keys` header — only slot names are
   * persisted server-side.
   */
  readonly runtimeModelOverrides?: Readonly<Record<string, string>>;
}
