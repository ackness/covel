/**
 * Event, message and character record types.
 *
 * Split out of `../types.ts` by domain; re-exported there as the public entry point.
 */

export interface EventRecord {
  readonly id: string;
  readonly sessionId: string;
  readonly type: string;
  readonly topic: string;
  readonly payload: unknown; // JSON
  readonly turnId?: string;
  readonly createdAt: string;
}

export interface MessageRecord {
  readonly id: string;
  readonly sessionId: string;
  readonly role: string;
  readonly content: string;
  readonly metadata?: unknown; // JSON
  readonly createdAt: string;
}

export type { CharacterRecord } from "@covel/shared";
