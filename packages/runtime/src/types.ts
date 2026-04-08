/**
 * Runtime execution engine types.
 */

import type { RuntimeManifest, RuntimeResult, TurnInput, TurnResult } from '@covel/shared';
import type { TurnMessageRecord } from '@covel/store';

// ── Trigger evaluation ───────────────────────────────────────────

export interface TriggerContext {
  readonly sessionId: string;
  readonly turnNumber: number;
  /** How many times this runtime has been triggered in this session. */
  readonly triggerCount: number;
  /** Turns since last trigger. */
  readonly turnsSinceLastTrigger: number;
  /** Pending events (for event-type triggers). */
  readonly pendingEventTopics: readonly string[];
  /** Whether an upstream runtime has failed. */
  readonly hasUpstreamFailure: boolean;
  /** Whether this is a manual trigger request for this specific runtime. */
  readonly isManualTrigger: boolean;
}

// ── Scheduling ───────────────────────────────────────────────────

export interface ScheduledGroup {
  readonly priority: number;
  readonly runtimes: readonly RuntimeManifest[];
}

export interface DependencyEdge {
  /** Runtime that depends (format: pluginName/runtimeName or just name). */
  readonly dependent: string;
  /** Runtime being depended on. */
  readonly dependency: string;
}

// ── Context building ─────────────────────────────────────────────

export interface AssembledContext {
  /** Full system prompt (PLUGIN.md body + injected data). */
  readonly systemPrompt: string;
  /** Additional context messages. */
  readonly messages: readonly LLMMessage[];
}

export interface LLMMessage {
  readonly role: 'system' | 'user' | 'assistant' | 'tool';
  readonly content: string;
  readonly name?: string;
  readonly toolCallId?: string;
}

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
  readonly messageHistory?: readonly TurnMessageRecord[];
}
