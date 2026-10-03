/** Stable author capabilities; provider-specific services are host extensions. */
import type { PluginInputSlot, PluginServiceClient } from "./plugin-api.js";
import type { ExtensionWorldModel } from "./extension-points.js";
import type { HandlerResult, JobStatusEffect } from "./handler-result.js";
import type { PluginToolResult } from "./tool-result.js";
import type { PluginMessages } from "./messages.js";

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
  /** Read the canonical session record. */
  getSession(): Promise<unknown>;
  /** List recent turn messages for the session (read-only timeline access). */
  listTurnMessages(limit?: number): Promise<unknown[]>;
  /**
   * Page the full turn-message log oldest-first, including messages already
   * folded into compaction summaries. `cursor` marks the last message read
   * (or echoes `after` for an empty page); pass it back as `after` to
   * continue, or persist it to resume incrementally later. `hasMore` is
   * false once the current end of the log is reached. `limit` defaults to
   * 100 and is capped at 500.
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

export interface PluginDataWriter {
  /**
   * Upsert a single plugin_data row. When `value === null`, the row is
   * deleted — matches the generic "set-or-delete" pattern other kernel
   * writers use.
   */
  set(namespace: string, key: string, value: unknown): Promise<void>;
  /** Read the current value for a key (returns `null` when absent). */
  get(namespace: string, key: string): Promise<unknown>;
  /** List every entry in a namespace, newest first per store ordering. */
  list(
    namespace: string,
  ): Promise<ReadonlyArray<{ readonly key: string; readonly value: unknown }>>;
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

/** Scoped capabilities shared by function handlers and agent guards. */
export interface PluginFunctionContext {
  readonly sessionId: string;
  readonly turnId: string;
  readonly pluginId: string;
  readonly runtimeId: string;
  readonly playerMessage: string;
  /**
   * The scheduler's logical turn: committed main-loop player turns plus one.
   * Setup and the opening continuation share turn 1 with the first message;
   * `startTurn` and `interval` gates count in these units.
   */
  readonly logicalTurn?: number;
  readonly locale?: string;
  /** This plugin's translations, read by `translate` and `labelText`. */
  readonly messages?: PluginMessages;
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
  readonly userSettings?: Readonly<Record<string, unknown>>;
  readonly pluginData?: PluginDataWriter;
  readonly logger?: PluginLogger;
  readonly progress?: ProgressReporter;
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
