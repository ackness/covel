/** Stable author capabilities; provider-specific services are host extensions. */
import type {
  PluginHttp,
  PluginInputSlot,
  PluginServiceClient,
  PluginServiceGateway,
} from "./plugin-api.js";
import type { ExtensionWorldModel } from "./extension-points.js";
import type { HandlerResult, JobStatusEffect } from "./handler-result.js";
import type { PluginToolResult } from "./tool-result.js";
import type { PluginMessages } from "./messages.js";
import type { JsonValue, PluginDataReader } from "./types.js";
import type {
  PluginAssetProgress,
  PluginImages,
  PluginMedia,
  PluginMusic,
  PluginSpeech,
} from "./media.js";

export interface FunctionStoreView {
  /** Read a single plugin_data row scoped to the calling plugin. */
  getPluginData(
    namespace: string,
    key: string,
  ): Promise<{ readonly key: string; readonly value: unknown } | null>;
  /** List every plugin_data row in a namespace scoped to the calling plugin. */
  listPluginData(
    namespace: string,
  ): Promise<ReadonlyArray<{ readonly key: string; readonly value: unknown }>>;
  /** Read accepted inputs for this session; values remain immutable. */
  listPlayerInputs(): Promise<
    readonly {
      readonly id: string;
      readonly formId: string;
      readonly turnId: string;
      readonly values: unknown;
    }[]
  >;
  /** Read the current session's clock, language and setup progress. */
  getSession(): Promise<PluginSessionView>;
  /**
   * List recent turn messages for the session (read-only timeline access).
   * Committed messages only: the running turn is not among them. Read it from
   * `playerMessage`, an input binding, or the `turn-digest@1` kernel input.
   */
  listTurnMessages(limit?: number): Promise<unknown[]>;
  /**
   * Page the full turn-message log in the order messages were saved,
   * including messages already folded into compaction summaries. `cursor`
   * marks the last message read (or echoes `after` for an empty page); pass
   * it back as `after` to continue, or persist it to resume incrementally
   * later: a message saved after the cursor always comes after it, even when
   * its timestamp is older (a background execution saved after a turn).
   * `hasMore` is false once the current end of the log is reached. `limit`
   * defaults to 100 and is capped at 500.
   */
  readTurnMessages(options?: {
    readonly after?: string;
    readonly limit?: number;
  }): Promise<{
    readonly messages: readonly PluginTurnMessage[];
    readonly cursor: string | null;
    readonly hasMore: boolean;
  }>;
}

/** One committed timeline entry as exposed to plugin code. */
export interface PluginTurnMessage {
  readonly id: string;
  readonly turnId: string;
  /** `player`, `system` or `runtime` for ordinary timeline entries. */
  readonly sourceType: string;
  readonly sourcePluginId?: string;
  readonly sourceRuntimeId?: string;
  readonly role: string;
  readonly content: string;
  readonly createdAt: string;
  /** True when prompts show this message through a compaction summary. */
  readonly compacted: boolean;
}

/**
 * The current session as plugin code reads it: a read-only projection of the
 * kernel's session record, not the record itself.
 */
export interface PluginSessionView {
  /** `setup` until every setup runtime is resolved, then `playing`. */
  readonly phase: "setup" | "playing";
  /** Committed main-loop player turns; setup and the opening do not count. */
  readonly completedPlayerTurns: number;
  /** The session's content locale, fixed when the session was created. */
  readonly locale: string;
  /** Setup progress of each setup runtime, keyed by runtime ID. */
  readonly setupRuntimes: Readonly<Record<string, PluginSetupRuntimeState>>;
}

/** Where one setup runtime stands in the current session. */
export type PluginSetupRuntimeState =
  | {
      readonly state: "pending";
      /** Error of the latest failed attempt, when there was one. */
      readonly lastError?: string;
    }
  | {
      readonly state: "done";
      /** `waived` when the player skipped the step after it failed. */
      readonly resolution: "completed" | "waived";
      readonly warning?: string;
    }
  | {
      readonly state: "blocked";
      readonly reason: string;
      readonly lastError?: string;
    };

/** Why the current execution runs. */
export type PluginExecutionOrigin =
  "player" | "continuation" | "manual" | "background" | "recursive" | "resume";

/** Read-only identity of the execution a handler runs in. */
export interface PluginExecutionInfo {
  readonly origin: PluginExecutionOrigin;
  /**
   * Set when this execution retries runtimes of an earlier committed turn:
   * the ID of that turn. Key rolls and reveals by it so a retry reuses them
   * instead of drawing again.
   */
  readonly sourceTurnId?: string;
}

/** How the scheduler activated this runtime this time. */
export interface PluginRuntimeActivation {
  readonly source: "stage" | "event" | "manual";
  readonly detached: boolean;
  /** `null` when the caller gave no payload. */
  readonly payload: JsonValue;
}

/** The player's latest accepted form submission. */
export interface PluginPlayerInputSubmission {
  readonly id: string;
  readonly sessionId: string;
  readonly turnId: string;
  readonly formId: string;
  readonly values: Readonly<Record<string, JsonValue>>;
  readonly createdAt: string;
}

/**
 * The `turn-digest@1` kernel input: frozen facts of the source turn, the same
 * value for a foreground runtime and a detached job.
 */
export interface PluginTurnDigest {
  readonly turnId: string;
  readonly playerMessage: string;
  readonly lastPlayerInput: PluginPlayerInputSubmission | null;
  /** Story text of the turn's successful story runtimes, joined by blank lines. */
  readonly narrativeText: string;
  /** One short line per successful, visible tool call. */
  readonly toolCallSummaries: readonly string[];
  readonly runtimeResults: readonly {
    readonly runtimeId: string;
    readonly status: "success" | "failed" | "skipped" | "suspended";
  }[];
  readonly locale?: string;
}

/** What `ctx.recursiveCall` may change; everything else comes from the parent. */
export interface PluginRecursiveCallDelta {
  /** Player message the nested execution sees. Defaults to the parent's. */
  readonly playerMessage?: string;
  /** Run one manual runtime of this plugin, with an optional payload. */
  readonly manualTrigger?: {
    readonly runtimeId: string;
    readonly payload?: Readonly<Record<string, unknown>>;
  };
}

export type PluginRuntimeStatus =
  "pending" | "running" | "success" | "failed" | "skipped" | "suspended";

/** One runtime's result inside a nested execution. */
export interface PluginNestedRuntimeResult {
  readonly pluginId: string;
  readonly runtimeId: string;
  readonly status: PluginRuntimeStatus;
  readonly output: Readonly<Record<string, unknown>> | null;
  readonly error?: string;
}

/** What a nested execution returns; the parent's commit persists its effects. */
export interface PluginNestedTurnResult {
  readonly turnId: string;
  readonly runtimeResults: readonly PluginNestedRuntimeResult[];
  /** Results of executions nested deeper still, flattened. */
  readonly nestedRuntimeResults?: readonly PluginNestedRuntimeResult[];
  /** Why the nested execution stopped before any runtime ran, when it did. */
  readonly abortReason?: string;
}

export interface PluginDataWriter extends PluginDataReader {
  /**
   * Upsert a single plugin_data row. When `value === null`, the row is
   * deleted — matches the generic "set-or-delete" pattern other kernel
   * writers use.
   */
  set(namespace: string, key: string, value: unknown): Promise<void>;
  /** Delete a row explicitly. */
  delete(namespace: string, key: string): Promise<void>;
}

/**
 * Structured logger exposed to plugin handlers. Each call appends a new
 * row under the plugin's `_logs` namespace keyed by timestamp+uuid so
 * entries are append-only and naturally ordered.
 */
export interface PluginLogger {
  debug(message: string, meta?: Record<string, unknown>): Promise<void>;
  info(message: string, meta?: Record<string, unknown>): Promise<void>;
  warn(message: string, meta?: Record<string, unknown>): Promise<void>;
  error(message: string, meta?: Record<string, unknown>): Promise<void>;
}

/**
 * The host's source of chance for dice and other game rolls. Draw from it
 * instead of `node:crypto` or `Math.random`: a test server started with
 * `COVEL_RANDOM_SEED` then gives the same draws on every run of one scripted
 * session.
 */
export interface PluginRandom {
  /** A uniform integer `min <= n < max`, as `randomInt` of `node:crypto`. */
  int(min: number, max: number): number;
}

export type JobStatusState =
  | "queued"
  | "running"
  | "progress"
  | "waiting-input"
  | "succeeded"
  | "failed"
  | "cancelled";

export type ProgressEffect = JobStatusEffect;
export interface ProgressReporter {
  /** Live status only; durable state writes remain buffered until commit. */
  report(effect: ProgressEffect): Promise<void>;
}

/**
 * Everything a host passes to function handlers and agent guards. A field
 * marked optional is present only when the host has it for this run (a
 * gateway when a model is configured, `inputs` when the runtime binds any).
 */
export interface PluginFunctionContext {
  readonly sessionId: string;
  readonly turnId: string;
  readonly pluginId: string;
  readonly runtimeId: string;
  readonly playerMessage: string;
  /**
   * The scheduler's logical turn: committed main-loop player turns plus one.
   * Setup and the opening continuation share turn 1 with the first message;
   * `startTurn` and `every` gates count in these units.
   */
  readonly logicalTurn?: number;
  readonly locale?: string;
  /** This plugin's translations, read by `translate` and `labelText`. */
  readonly messages?: PluginMessages;
  /** The player's latest accepted form submission, or `null`. */
  readonly session: {
    readonly lastPlayerInput: PluginPlayerInputSubmission | null;
  };
  readonly store: FunctionStoreView;
  readonly world?: ExtensionWorldModel;
  readonly services?: PluginServiceClient;
  readonly tools?: {
    call(
      name: string,
      args: Readonly<Record<string, unknown>>,
    ): Promise<unknown>;
  };
  readonly manualPayload?: Readonly<Record<string, unknown>>;
  readonly resumeData?: unknown;
  readonly resumedFromSuspensionId?: string;
  readonly triggerEvent?: {
    readonly topic: string;
    readonly data: Readonly<Record<string, unknown>>;
  };
  readonly inputs?: Readonly<Record<string, PluginInputSlot>>;
  readonly exports?: Readonly<Record<string, PluginInputSlot>>;
  /** How the scheduler activated this runtime; absent for a guard. */
  readonly activation?: PluginRuntimeActivation;
  /** Identity of the running execution; absent for a guard. */
  readonly execution?: PluginExecutionInfo;
  /**
   * Run one manual runtime of this plugin inside the current execution. Its
   * effects commit with the parent's.
   */
  readonly recursiveCall: (
    delta: PluginRecursiveCallDelta,
    opts?: { readonly reason?: string },
  ) => Promise<PluginNestedTurnResult>;
  /** 0 for a top-level execution, one more for each `recursiveCall` level. */
  readonly recursionDepth: number;
  readonly userSettings?: Readonly<Record<string, unknown>>;
  readonly pluginData?: PluginDataWriter;
  readonly logger?: PluginLogger;
  readonly progress?: ProgressReporter;
  /** Model calls through the session's slots; present when a model is configured. */
  readonly gateway?: PluginServiceGateway;
  /** The host's outbound HTTP checks and retrying fetch. */
  readonly utils?: PluginHttp;
  readonly media?: PluginMedia;
  readonly images?: PluginImages;
  readonly speech?: PluginSpeech;
  readonly music?: PluginMusic;
  readonly assetProgress?: (progress: PluginAssetProgress) => Promise<void>;
  /** Dice and other game rolls. */
  readonly random: PluginRandom;
  readonly signal?: AbortSignal;
}

/** Add explicit host capabilities when a handler needs more than the core API. */
export type PluginFunctionHandler<Capabilities extends object = object> = (
  context: PluginFunctionContext & Capabilities,
) => Promise<HandlerResult | PluginToolResult<HandlerResult>>;

export type PluginAgentGuardResult = Readonly<Record<string, unknown>> & {
  readonly skip: boolean;
};
export type PluginAgentGuard<Capabilities extends object = object> = (
  context: PluginFunctionContext & Capabilities,
) => Promise<PluginAgentGuardResult | PluginToolResult<PluginAgentGuardResult>>;
