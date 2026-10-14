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

/**
 * `GET /api/sessions/:id/memory-index`: the embedding model a session's memory
 * index was built with, and whether the configuration still selects it.
 */
export interface SessionMemoryIndexStatus {
  /** False when the server keeps no vector index (no vector support, or `VECTOR_BACKEND=none`). */
  readonly available: boolean;
  /** The model the index was built with; null before the session is first indexed. */
  readonly locked: {
    readonly provider: string;
    readonly modelName: string;
    readonly dim: number;
    readonly lockedAt: string | null;
  } | null;
  /** The embedding model the configuration selects now; null when none is configured. */
  readonly configured: {
    readonly provider: string;
    readonly modelName: string;
  } | null;
  /**
   * True when `configured` is not the model in `locked`. Memory search then
   * matches keywords only, and nothing new is indexed, until the index is
   * rebuilt (`POST /api/sessions/:id/memory-index/rebuild`) or the old model
   * is configured again.
   */
  readonly stale: boolean;
}

export interface Session {
  readonly id: string;
  /** Opaque API identity for one persisted incarnation; not an authorization token. */
  readonly incarnation: string;
  readonly worldId?: string;
  /** Lifecycle flag. `active` under normal play; `paused`/`ended` stops scheduling. */
  readonly status: SessionStatus;
  /** Authoritative setup/main-loop scheduling phase. */
  readonly phase: "setup" | "playing";
  /** Number of committed main-loop player turns. */
  readonly completedPlayerTurns: number;
  /** Per-runtime setup lifecycle mirror, keyed by runtimeId. */
  readonly setupRuntimes: Readonly<Record<string, SetupRuntimeState>>;
  readonly activePlugins: readonly string[];
  readonly locale: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  /**
   * FK to vector_models.id; null/undefined = RAG disabled for this session.
   * Set when the session is first indexed; a memory index rebuild moves it
   * to the model configured at that time.
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
   * name from `llm.toml` (e.g. `"story"`, `"utility"`, `"fast"`).
   *
   * The model-slot resolver consults this map first; if absent, it follows
   * the priority chain in docs/reference/slots.md. Provider/key configuration
   * stays in localStorage + `X-Provider-Keys` header — only slot names are
   * persisted server-side.
   */
  readonly runtimeModelOverrides?: Readonly<Record<string, string>>;
}
