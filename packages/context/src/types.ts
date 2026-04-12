/**
 * Context assembly types.
 */

import type { RuntimeManifest, RuntimeResult, TurnInput } from '@covel/shared';
import type { BudgetOptions, TokenEstimator } from './budget.js';

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
  /**
   * Latest player form submission for this session. Populated from the
   * `player_inputs` table — the most recent row wins. Plugins read this via
   * `{{ player.lastFormValues }}` to process form submissions without
   * server-side magic.
   */
  readonly lastFormValues?: Readonly<Record<string, unknown>>;
}

/** A single Working Memory entry (minimal shape for context injection). */
export interface WorkingMemoryEntry {
  readonly scope: 'player' | 'story' | 'shared';
  readonly key: string;
  readonly value: unknown;
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
  /**
   * Working memory entries (S3-T3). Populated when COVEL_WORKING_MEMORY_V1=1.
   * When absent or empty, no [Working Memory] segment is rendered.
   */
  readonly workingMemory?: readonly WorkingMemoryEntry[];
  /**
   * Token estimator injected by the caller for budget calculation. Optional.
   * When both this and {@link ContextBuildParams.contextBudget} are set and
   * `COVEL_CONTEXT_BUDGET_V1=1` is in the environment, the builder runs a
   * pruning pass before returning the assembled context.
   */
  readonly estimator?: TokenEstimator;
  /**
   * Budget config. If present together with `estimator` and the feature
   * flag, message pruning runs. The `estimator` field of `BudgetOptions`
   * is supplied via {@link ContextBuildParams.estimator}, so callers need
   * only provide the numeric limits here.
   */
  readonly contextBudget?: Omit<BudgetOptions, 'estimator'>;
  /**
   * V2 (three-tier prompt assembler) only — caller override for segment 1
   * (framework preamble). When omitted, V2 derives a minimal locale-based
   * preamble. V1 ignores this field. Introduced in S2-T1.
   */
  readonly frameworkPreamble?: string;
}
