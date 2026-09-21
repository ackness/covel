import type {
  NestedTurnResult,
  RecursiveCallDelta,
  JobStatusRecord,
  InputSlot,
  RuntimeActivation,
  ExecutionContext,
  HandlerResult,
} from "../index.js";
import type {
  PluginRuntimeGateway,
  PluginRuntimeUtils,
  MediaContext,
  ImagesContext,
  SpeechContext,
  AssetProgressInput,
} from "./services.js";

/**
 * Function handler context — passed to `runtimeType: 'function'` handlers.
 * The handler receives this context and returns a Record<string, unknown> output.
 */
export interface FunctionHandlerContext {
  /** Public, schema-validated services exported by active plugins. */
  readonly services?: import("./plugin-services.js").PluginServiceClient;
  readonly sessionId: string;
  readonly turnId: string;
  /** Plugin ID this handler belongs to (derived from manifest). */
  readonly pluginId: string;
  /** Runtime ID this handler belongs to (full manifest name). */
  readonly runtimeId: string;
  readonly playerMessage: string;
  readonly locale?: string;
  /**
   * Store handle exposed to the runtime. Community plugins receive a
   * narrow `FunctionStoreView` that only allows scoped reads — broader
   * mutations must go through `ctx.pluginData` or the handler's return
   * value (proposal pipeline). Builtin plugins receive explicit domain reads
   * and four proposal-backed writes, never host transactions or lifecycle
   * methods (typed as `unknown` here to avoid a @covel/store dependency).
   * The runtime decides which to inject based on discovery-source trust.
   */
  readonly store: unknown;
  /** Declared tools, with schema/approval checks and transactional writes. Function runtimes only. */
  readonly tools?: {
    call(
      name: string,
      args: Readonly<Record<string, unknown>>,
    ): Promise<unknown>;
  };
  /**
   * Optional gateway facade for function runtimes that need LLM / image /
   * structured-object generation. Absent when the executor was constructed
   * without a `gateway` dep (e.g. test harnesses). Handlers must null-check
   * before use and surface a clear error when the dep is missing rather
   * than assuming availability.
   */
  readonly gateway?: PluginRuntimeGateway;
  /**
   * Vetted utility helpers (SSRF guard + retrying fetch). Always present
   * in production — only absent in test harnesses constructed without
   * `utils` wired. Plugins that own their own wire format should prefer
   * `utils.fetchWithRetry` over bare `fetch` and gate every user-supplied
   * URL through `utils.validateBaseUrl` before calling it.
   */
  readonly utils?: PluginRuntimeUtils;
  /**
   * Media storage primitives for function runtimes. Present when the
   * runtime is wired with a MediaStore. `ingestUrl` applies the framework
   * SSRF, redirect, timeout, byte budget, and MIME validation policy before
   * persisting bytes.
   */
  readonly media?: MediaContext;
  /**
   * Unified image-generation pipeline (framework primitive). Present when
   * the executor is wired with both a gateway and a MediaStore.
   */
  readonly images?: ImagesContext;
  /**
   * Unified speech pipeline — TTS (persisted MediaRefs) and STT. Present
   * under the same wiring conditions as `images`.
   */
  readonly speech?: SpeechContext;
  /**
   * Emits generation progress as `asset.progress` trace/SSE events. The
   * final durable output remains `assetGenerations[]` → `asset.generate`.
   */
  readonly assetProgress?: (progress: AssetProgressInput) => Promise<void>;
  /** Run a nested turn with a partial input override. Depth is bounded by runtime governance. */
  readonly recursiveCall: (
    delta: RecursiveCallDelta,
    opts?: { readonly reason?: string },
  ) => Promise<NestedTurnResult>;
  /** Current recursiveCall depth. Top-level runtime executions start at 0. */
  readonly recursionDepth: number;
  /**
   * Optional manual-trigger payload — only populated when the turn was
   * initiated via `POST /api/sessions/:id/plugin-rpc` with a `runtimeId`
   * targeting this runtime. Normal auto/scheduled/event runs leave it
   * undefined, so handlers can branch on presence to pick up click-time
   * context (selected character, user input, etc.).
   */
  readonly manualPayload?: Readonly<Record<string, unknown>>;
  /**
   * Data supplied to the resume API for a suspended function runtime. Unlike
   * `manualPayload`, this may be any JSON-schema-valid value (including a
   * primitive), and is present only while re-entering the suspended handler.
   */
  readonly resumeData?: unknown;
  /** Suspension identity associated with `resumeData`, for correlation only. */
  readonly resumedFromSuspensionId?: string;
  /**
   * Optional trigger-event descriptor — only populated when this runtime
   * was activated by the in-turn event chain (an earlier runtime in the
   * same turn emitted `output.events: [{ topic, data }]` matching this
   * runtime's `trigger: { type: 'event', topic }`). Absent for manual,
   * scheduled, and auto-trigger activations.
   */
  readonly triggerEvent?: {
    readonly topic: string;
    readonly data: Readonly<Record<string, unknown>>;
  };
  /**
   * Resolved same-execution input bindings (`inputs.<name>`), each wrapped in
   * provenance (`InputSlot`). Populated for `stage` / `event` activations that
   * pass the binding gate; a `manual` activation projects turn bindings away,
   * leaving this empty (docs 02 §3.2, 01 §4). Read `ctx.inputs.<name>.value`
   * (`one`) or `ctx.inputs.<name>.items[]` (`all`).
   */
  readonly inputs?: Readonly<Record<string, InputSlot>>;
  /**
   * Resolved cross-execution `recordAs` exports (`input.inject` runtime-export),
   * each provenance-wrapped. Reads the producer's latest revision committed
   * before this execution started (docs 02 §3.4). Same shape as `ctx.inputs`:
   * `ctx.exports.<name>.value` (`one`) or `.items[]` (`all`).
   */
  readonly exports?: Readonly<Record<string, InputSlot>>;
  /**
   * Canonical activation for this run (docs 02 §3.3). `payload` is the
   * `input.schema`-validated manual/event payload (`null` for a stage run).
   * `ctx.manualPayload` / `ctx.triggerEvent.data` are compat aliases of the
   * same value.
   */
  readonly activation?: RuntimeActivation;
  /** Execution identity of this scheduling run (docs 01 §4). */
  readonly execution?: ExecutionContext;
  /**
   * Resolved player-authored plugin settings for THIS plugin, with
   * `manifest.userSettings[].default` applied for any key the player
   * hasn't overridden. Every key declared in the manifest is
   * guaranteed to be present. Absent when no `userSettings` were declared
   * — callers don't need to defensively read it in that case.
   *
   * Scoped to the runtime's own pluginId — a plugin cannot observe
   * another plugin's settings through this channel.
   */
  readonly userSettings?: Readonly<Record<string, unknown>>;
  /**
   * Scoped plugin-data writer. Production runtime writes join the execution's
   * proposal buffer and become visible after commit. Reads see buffered writes
   * through both this handle and the scoped store view. Use `progress` for live
   * status updates. Absent without a `store` dependency in test harnesses.
   */
  readonly pluginData?: PluginDataWriter;
  /**
   * Per-runtime logger. Every call appends a row in the plugin's `_logs`
   * namespace so plugin-authored diagnostics survive restarts and can be
   * inspected from `/api/sessions/:id/plugin-data/:pluginId/_logs`.
   * Absent in test harnesses without a store.
   */
  readonly logger?: PluginLogger;
  /**
   * Real-time progress channel for long-running work (media generation, etc.).
   * Reports append to the kernel job-status stream and emit an SSE event before
   * the turn's finalizer runs — the ONE effect a handler may surface live. The
   * durable domain output still flows through the return value / proposals.
   * Absent when the executor was constructed without a `store` dep.
   */
  readonly progress?: ProgressReporter;
  /**
   * Cancellation for this execution, including player abort, runtime deadlines
   * and host shutdown. Thread it into long provider calls and bespoke fetches.
   * Absent in non-abortable test harnesses. Commit policy belongs to the host:
   * player abort may preserve completed work, while background execution
   * cancellation is also checked at the domain commit boundary. A handler must
   * not assume that returning a result guarantees its proposals will commit.
   */
  readonly signal?: AbortSignal;
}

/**
 * Read-only DataStore view for community handlers. Session reads bind to the
 * current session and plugin-data reads bind to the calling plugin.
 *
 * Builtin plugins receive additional explicit world/character reads and
 * proposal-backed plugin-data/character writes. Neither surface exposes host
 * transaction, session mutation, or disposal methods. Reads return owned
 * snapshots, including when persistence uses MemoryStore.
 *
 * Write own data with `ctx.pluginData` or use `ctx.tools.call` for declared
 * domain commands; both feed the proposal / commit pipeline.
 */
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
  listPlayerInputs(sessionId?: string): Promise<
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
}

/**
 * Handler-facing wrapper over `DataStore.setPluginData` scoped to the
 * active session + plugin. Callers cannot write to another plugin's
 * namespace through this handle — the kernel binds `pluginId`.
 */
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

/**
 * Job business fields a handler supplies to `ctx.progress.report`. The kernel
 * injects the identity (session / scope / plugin / runtime) and timestamp, so a
 * handler cannot forge another plugin's or runtime's job.
 */
export type ProgressEffect = Omit<
  JobStatusRecord,
  "sessionId" | "progressScopeId" | "pluginId" | "runtimeId" | "createdAt"
>;

/**
 * The sole real-time channel exposed to a long-running function runtime.
 * Progress reports append to the kernel job-status store and emit an SSE event
 * immediately — they do NOT write gameplay state and do NOT roll back with the
 * domain transaction. All domain writes still flow through the handler's return
 * value / proposals.
 */
export interface ProgressReporter {
  /**
   * Append one progress event. Append-only + idempotent on `sequence`: a
   * duplicate/older sequence for the same job is silently dropped. `data` is
   * validated against the JSON wire boundary and rejected with a throw on
   * non-serialisable values (undefined / function / circular / non-finite).
   */
  report(effect: ProgressEffect): Promise<void>;
}

/** Function handler signature for `runtimeType: 'function'` runtimes. */
export type FunctionHandler = (
  ctx: FunctionHandlerContext,
) => Promise<HandlerResult>;

/** Agent pre-execution guard result. Guards are gates, not function runtimes. */
export type AgentGuardResult = Readonly<Record<string, unknown>> & {
  readonly skip: boolean;
};

export type AgentGuard = (
  ctx: FunctionHandlerContext,
) => Promise<AgentGuardResult>;
