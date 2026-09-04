/**
 * Plugin RPC channel types.
 *
 * Three invocation kinds flow through the same channel:
 *
 *   - **Action level** (`{ kind: "action", pluginId, action, payload }`):
 *     Looks up the action registered by the plugin entry module and runs its
 *     handler. Used for high-level structured commands like
 *     "submit-form", "regenerate", "cancel".
 *
 *   - **Runtime level** (`{ kind: "runtime", pluginId, runtimeId, payload }`):
 *     Manually triggers a single runtime through the turn pipeline,
 *     bypassing the trigger router. Used for "regenerate this card" /
 *     "rerun the codex extractor" style operations.
 *
 *   - **Command level** (`{ kind: "command", commandId, input | args }`):
 *     Resolves a server-discovered slash command for the active session and
 *     dispatches its server-owned plugin action after validation.
 *
 * Trust levels mirror the plugin source taxonomy:
 *   - `builtin`: shipped with the framework, auto-allowed
 *   - `community`: third-party, requires explicit per-action approval
 */

import type { SlashCommandInvocation } from "./plugin.js";

export type RpcTrustLevel = "builtin" | "community";

/**
 * Narrow structural store interface exposed to RPC handlers.
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

// ── Wire format ──────────────────────────────────────────────────

/**
 * Request body for `POST /api/sessions/:id/plugin-rpc`.
 *
 * `kind` is the required discriminator. The server never infers an invocation
 * kind from the presence of `action`, `runtimeId`, or `commandId`.
 */
export interface PluginRpcActionRequest {
  readonly kind: "action";
  readonly pluginId: string;
  readonly action: string;
  readonly payload?: unknown;
}

export interface PluginRpcRuntimeRequest {
  readonly kind: "runtime";
  readonly pluginId: string;
  readonly runtimeId: string;
  readonly payload?: unknown;
  /**
   * Runtime-level calls can opt into immediate background acknowledgement when
   * the target runtime is only a prompt-builder for a background follower.
   */
  readonly expectsBackgroundFollower?: boolean;
  /**
   * Retry a runtime that failed in a prior turn: the server loads that turn's
   * persisted `turn_results` artifact and seeds the execution with its
   * recorded runtime outputs, so the target's `input.inject` / `needs`
   * resolve against the original narrative instead of empty context.
   */
  readonly retryFromTurnId?: string;
}

/** Execute one server-discovered slash command from composer text. */
export interface PluginRpcTextCommandRequest {
  readonly kind: "command";
  /** Stable id returned by the session command directory. */
  readonly commandId: string;
  /** Original composer input; parsed and validated again by the server. */
  readonly input: string;
  readonly args?: never;
}

/** Execute the same command from a plugin-owned structured UI action. */
export interface PluginRpcStructuredCommandRequest {
  readonly kind: "command";
  /** Stable id built from the rendering plugin and canonical command name. */
  readonly commandId: string;
  /** Named arguments; validated against the server-selected command spec. */
  readonly args: Readonly<Record<string, unknown>>;
  readonly input?: never;
}

export type PluginRpcCommandRequest =
  PluginRpcTextCommandRequest | PluginRpcStructuredCommandRequest;

export type PluginRpcRequest =
  PluginRpcActionRequest | PluginRpcRuntimeRequest | PluginRpcCommandRequest;

export type RpcCommandSource = "composer" | "plugin-ui";

/** Canonical command shape passed to handlers and written to command traces. */
export interface RpcCommandInvocation extends SlashCommandInvocation {
  readonly invocationId: string;
  readonly commandId: string;
  readonly source: RpcCommandSource;
}

export interface RpcCommandSessionEnvironment {
  readonly id: string;
  readonly worldId?: string;
  readonly status: string;
  readonly phase?: string;
  readonly locale?: string;
}

export interface RpcCommandRuntimeEnvironment {
  readonly id: string;
  readonly pluginId: string;
  readonly runtimeType: string;
  readonly outputKind: string;
  readonly stage?: string;
  readonly capabilities: readonly string[];
  /** Present only when the command declared the `models` context scope. */
  readonly model?: {
    readonly slot: string;
    readonly resolved?: string;
    readonly source: "session-override" | "manifest" | "default";
  };
}

/** Least-privilege environment snapshot built for a command at dispatch time. */
export interface RpcCommandEnvironment {
  readonly capturedAt: string;
  readonly session?: RpcCommandSessionEnvironment;
  readonly activeRuntimes?: readonly RpcCommandRuntimeEnvironment[];
}

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
      /** Post-dispatch snapshot, limited to the command's declared scopes. */
      readonly environment?: RpcCommandEnvironment;
      readonly turnId?: string;
      readonly runtimeResults?: readonly PluginRpcRuntimeResultSummary[];
      readonly durationMs?: number;
      readonly abortReason?: string;
      readonly deferredJobs?: readonly PluginRpcDeferredJob[];
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
    };
