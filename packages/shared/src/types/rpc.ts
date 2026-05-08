/**
 * PR-3: Plugin RPC channel types.
 *
 * Two RPC modes flow through the same channel:
 *
 *   - **Action level** (`{ pluginId, action, payload }`):
 *     Looks up `manifest.rpc[action]` for the named plugin and runs the
 *     declared handler. Used for high-level structured commands like
 *     "submit-form", "regenerate", "cancel".
 *
 *   - **Runtime level** (`{ pluginId, runtimeId, payload }`):
 *     Manually triggers a single runtime through the turn pipeline,
 *     bypassing the trigger router. Used for "regenerate this card" /
 *     "rerun the codex extractor" style operations.
 *
 * Trust levels mirror the plugin source taxonomy:
 *   - `builtin`: shipped with the framework, auto-allowed
 *   - `official`: in the maintained whitelist, auto-allowed
 *   - `community`: third-party, requires explicit per-action approval (PR-7)
 */

export type RpcTrustLevel = "builtin" | "official" | "community";

/**
 * Narrow structural store interface exposed to RPC handlers (LOW-2 fix).
 *
 * Plugin authors compile against this surface — not the full `DataStore` —
 * so they get autocomplete and type checking inside their handlers without
 * the runtime package having to depend on `@covel/store`. The framework
 * casts the real `DataStore` to this type at the dispatch call site.
 *
 * Adding new methods here is a breaking-change boundary: any new field
 * widens the contract that every handler can rely on. Keep it minimal.
 */
export interface RpcHandlerStore {
  // ── Sessions ─────
  getSession(id: string): Promise<unknown>;
  // ── Turn messages ─────
  listTurnMessages(sessionId: string): Promise<
    ReadonlyArray<{
      readonly turnId: string;
      readonly content: string;
      readonly order: number;
      readonly pendingInput?: unknown;
      readonly name?: string;
    }>
  >;
  // ── Player input persistence ─────
  savePlayerInput(input: {
    readonly id: string;
    readonly sessionId: string;
    readonly turnId: string;
    readonly formId: string;
    readonly values: Record<string, unknown>;
    readonly createdAt: string;
  }): Promise<void>;
  // ── Plugin data KV ─────
  setPluginData?(record: {
    readonly sessionId: string;
    readonly pluginId: string;
    readonly namespace: string;
    readonly key: string;
    readonly value: unknown;
    readonly createdAt: string;
    readonly updatedAt: string;
  }): Promise<void>;
  getPluginData?(
    sessionId: string,
    pluginId: string,
    namespace: string,
    key: string,
  ): Promise<unknown>;
  listPluginData?(
    sessionId: string,
    pluginId: string,
    namespace: string,
  ): Promise<ReadonlyArray<{ key: string; value: unknown }>>;
}

/**
 * Declaration for a single RPC action on a plugin manifest. Lives under
 * `RuntimeManifest.rpc[actionName]`. Handlers are loaded lazily on first
 * dispatch — there is no eager import at parse time.
 */
export interface RpcActionDecl {
  /** Relative path to the handler module (default export of `RpcHandler`). */
  readonly handler: string;
  /** Optional path to a JSON Schema describing the payload shape. */
  readonly input?: string;
  /** Trust level for approval gating. Defaults to the plugin's source trust. */
  readonly trustLevel?: RpcTrustLevel;
  /** Whether the handler streams progress events. Defaults to `false`. */
  readonly streaming?: boolean;
  /** One-line human-readable description for UI / approval dialogs. */
  readonly description?: string;
}

/**
 * `RuntimeManifest.rpc` is a map of action names → declarations.
 *
 * Action names should be kebab-case (`submit-form`, `regenerate`,
 * `cancel-turn`). They are looked up case-sensitively at dispatch.
 */
export type RpcDeclMap = Readonly<Record<string, RpcActionDecl>>;

// ── Wire format ──────────────────────────────────────────────────

/**
 * Request body for `POST /api/sessions/:id/plugin-rpc`.
 *
 * Either `action` or `runtimeId` must be set, never both. Sending both
 * is a 400.
 */
export interface PluginRpcActionRequest {
  readonly pluginId: string;
  readonly action: string;
  readonly payload?: unknown;
}

export interface PluginRpcRuntimeRequest {
  readonly pluginId: string;
  readonly runtimeId: string;
  readonly payload?: unknown;
  /**
   * Runtime-level calls can opt into immediate background acknowledgement when
   * the target runtime is only a prompt-builder for a background follower.
   */
  readonly expectsBackgroundFollower?: boolean;
}

export type PluginRpcRequest = PluginRpcActionRequest | PluginRpcRuntimeRequest;

/**
 * Sync-mode response from `POST /api/sessions/:id/plugin-rpc?mode=sync`.
 * Streaming mode returns SSE — see `docs/reference/protocol.md`.
 */
export interface PluginRpcRuntimeResultSummary {
  readonly runtimeId: string;
  readonly pluginId: string;
  readonly status: string;
  readonly durationMs: number;
  readonly error?: string;
  readonly output: unknown;
}

export interface PluginRpcDeferredJob {
  readonly jobId: string;
  readonly runtimeId: string;
}

export type PluginRpcResponse =
  | {
      readonly status: "ok";
      readonly result?: unknown;
      readonly turnId?: string;
      readonly runtimeResults?: readonly PluginRpcRuntimeResultSummary[];
      readonly durationMs?: number;
      readonly abortReason?: string;
      readonly deferredJobs?: readonly PluginRpcDeferredJob[];
      /**
       * @deprecated Server writes expected-background-follower failures to
       * `_jobs/<jobId>` and returns `accepted`.
       */
      readonly failedJobs?: readonly PluginRpcDeferredJob[];
    }
  | {
      readonly status: "accepted";
      readonly jobId: string;
      readonly pending: true;
      readonly turnId: string;
      readonly runtimeId: string;
      readonly phase?: string;
    }
  | {
      readonly status: "approval-required";
      readonly approvalId: string;
      readonly pending?: unknown;
    }
  | {
      readonly status: "error";
      readonly error: string;
      readonly code?: string;
    };
