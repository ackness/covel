/**
 * Session lifecycle types.
 *
 * This file defines the wire-format `Session` shape — the contract between
 * server and any API client. The DB record `SessionRecord` in
 * `@covel/store` is a superset of this and may have backend-specific
 * fields; this type is what crosses the network boundary.
 */

export type SessionPhase = 'pre-game' | 'playing' | 'paused' | 'ended';

/**
 * Embedding model lock metadata returned alongside a session by
 * `GET /api/sessions/:id`. Surfaces what the session is bound to so
 * the UI can render a "RAG enabled — model X" indicator.
 */
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
  readonly phase: SessionPhase;
  readonly turnCount: number;
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
   * Global `turnNumber` (count of committed player messages) at the moment
   * this session first transitioned to the `playing` phase. Set exactly
   * once, on that transition, and never changes afterwards.
   *
   * Used by the trigger router (PR-2) to compute `playingTurnNumber` =
   * `turnNumber - playingTurnOffset`, so plugin authors can declare
   * `trigger.startTurn` in terms of "rounds since the game actually
   * started" rather than "rounds since session creation".
   *
   * Undefined/null when the session has not yet entered playing phase.
   */
  readonly playingTurnOffset?: number | null;
  /**
   * Per-runtime model slot overrides (PR-6).
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
