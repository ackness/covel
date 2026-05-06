/**
 * Session lifecycle types — wire contract between server and any API client.
 * DB record `SessionRecord` in `@covel/store` is a superset with backend fields.
 */

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
	 * Band selector. `0` = Pre-Game (only priority 0-99 scheduled, may iterate
	 * multiple player submissions). `>=1` = main loop (only priority 100-1000).
	 * Advances from 0 → 1 when all Pre-Game runtimes report done.
	 */
	readonly turnCount: number;
	/**
	 * RuntimeIds of Pre-Game band (priority 0-99) runtimes that have already
	 * completed this session. Used to gate the `turnCount: 0 → 1` transition.
	 */
	readonly preGameCompleted: readonly string[];
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
