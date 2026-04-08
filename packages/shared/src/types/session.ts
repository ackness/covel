/**
 * Session lifecycle types.
 */

export type SessionPhase = 'pre-game' | 'playing' | 'paused' | 'ended';

export interface Session {
  readonly id: string;
  readonly worldId?: string;
  readonly phase: SessionPhase;
  readonly turnCount: number;
  readonly activePlugins: readonly string[];
  readonly locale: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}
