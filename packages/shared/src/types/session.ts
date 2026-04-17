/**
 * Session lifecycle types — wire contract between server and any API client.
 * DB record `SessionRecord` in `@covel/store` is a superset with backend fields.
 */

export type SessionStatus = 'active' | 'paused' | 'ended';

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
  readonly embeddingModelId?: number | null;
  readonly embeddingLockedAt?: string | null;
  readonly embedding?: SessionEmbeddingInfo | null;
  readonly runtimeModelOverrides?: Readonly<Record<string, string>>;
}
