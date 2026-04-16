/**
 * Context assembly types.
 */

import type { RuntimeManifest, RuntimeResult, TurnInput } from '@covel/shared';
import type { DataStore } from '@covel/store';
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
  /**
   * Set by the compactor (S2-T2) when this message has been summarized.
   * The value is the `SessionSummaryRecord.id` of the summary that replaced
   * this span. The prompt-build path substitutes the summary when the flag
   * `COVEL_COMPACTOR_V1=1` is set.
   */
  readonly compactedAtTurnId?: string;
}

/**
 * Minimal summary record shape consumed by the context builder.
 * Matches `SessionSummaryRecord` from `@covel/store` but is
 * kept separate so `@covel/context` stays free of a store dep.
 */
export interface SummaryRecord {
  readonly id: string;
  readonly content: string;
  readonly focusSections: readonly string[];
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
  /**
   * Session summaries (S2-T2 Compactor).
   * When provided AND `COVEL_COMPACTOR_V1=1` is set, the prompt-build path
   * substitutes compacted message spans with their summary.
   * The caller (turn-executor) is responsible for loading these from the store.
   */
  readonly summaries?: readonly SummaryRecord[];
  /**
   * Active runtime manifests considered for segment-9/10 aggregation (S3-T4).
   *
   * V2 scans these manifests for their `authorsNote` and `postHistory` fields
   * and merges all declarations into the final prompt in `priority` order
   * (ascending, so earlier priorities render first). When omitted, V2 falls
   * back to `[params.manifest]` so a runtime's own notes still apply.
   *
   * V1 ignores this field. Only exercised under `COVEL_PROMPT_V2=1`.
   */
  readonly activeManifests?: readonly RuntimeManifest[];
  /**
   * Data store handle used by the async build path to resolve
   * `input.inject` entries of kind `plugin-data`. Only consulted when a
   * plugin-data inject is present in the manifest. The sync `buildContext`
   * path ignores this field entirely and stays byte-identical to the
   * pre-ticket behaviour.
   */
  readonly store?: DataStore;
  /**
   * Core memory blocks (Letta-style in-context memory).
   * When present, rendered as a `[Core Memory]` section in the prompt.
   * Managed by `@covel/memory` — the context builder only consumes the data.
   */
  readonly coreMemoryBlocks?: readonly {
    readonly label: string;
    readonly content: string;
  }[];
}
