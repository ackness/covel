/**
 * Context assembly types.
 */

import type { RuntimeManifest, RuntimeResult, TurnInput } from '@covel/shared';

/** A single LLM message in the conversation. */
export interface LLMMessage {
  readonly role: 'system' | 'user' | 'assistant' | 'tool';
  readonly content: string;
  readonly name?: string;
  readonly toolCallId?: string;
}

/** The assembled context ready for LLM execution. */
export interface AssembledContext {
  /** Full system prompt (PLUGIN.md body + injected data). */
  readonly systemPrompt: string;
  /** Conversation messages (history + current user message). */
  readonly messages: readonly LLMMessage[];
}

/** Message record from the store (minimal shape needed by context builder). */
export interface MessageHistoryRecord {
  readonly role: string;
  readonly content: string;
  readonly name?: string;
}

/** Summary of a character record for template injection. */
export interface CharacterSummary {
  readonly name: string;
  readonly type: string;
  readonly description?: string;
  readonly fields?: Record<string, unknown>;
}

/** Session-level metadata exposed to plugin templates. */
export interface SessionMeta {
  readonly turnNumber: number;
  readonly phase: string;
  readonly characters: readonly CharacterSummary[];
}

/** Parameters for building an execution context. */
export interface ContextBuildParams {
  /** Runtime's prompt template. */
  readonly promptTemplate: string;
  /** Runtime's manifest. */
  readonly manifest: RuntimeManifest;
  /** Current turn input. */
  readonly turnInput: TurnInput;
  /** Completed results from other runtimes (for inject). */
  readonly completedResults: ReadonlyMap<string, RuntimeResult>;
  /** Runtime's effective config values. */
  readonly config: Readonly<Record<string, unknown>>;
  /** Previous turn messages (append-only history from DataStore). */
  readonly messageHistory?: readonly MessageHistoryRecord[];
  /** Session-level metadata (turnNumber, phase, characters). */
  readonly sessionMeta?: SessionMeta;
}
