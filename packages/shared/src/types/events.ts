/**
 * Event and message routing types.
 */

export type MessageType = "message" | "event" | "callback";

export interface CovelMessage {
  readonly id: string;
  readonly type: MessageType;
  readonly topic: string;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly sessionId: string;
  /** Persisted session equality tag, captured by the producer before async work. */
  readonly sessionIncarnation?: string;
  readonly turnId?: string;
  readonly timestamp: string;
}
