/**
 * Public Plugin API — the types a plugin's unified server `entry` module is
 * written against.
 *
 * A PLUGIN.md `entry` module default-exports a factory (sync or async) that
 * receives the {@link PluginAPI} facade and registers the plugin's
 * server-side capabilities imperatively:
 *
 *   // JSDoc: @type {import('@covel/runtime').PluginEntryFactory}
 *   export default function (covel) {
 *     covel.registerTool(covel.toolkit.tool({ ... }));
 *     covel.on("PostLLMResponse", handler);
 *     covel.registerRpc("my-action", handler);
 *     covel.registerWires({ image: [myWire] });
 *   }
 *
 * These types are the stable contract between the framework and plugin
 * authors. The server bootstrap implements this facade; capability behavior
 * is also checked by integration tests at activation and invocation.
 */

import type {
  fetchWithRetry,
  validateBaseUrlForPlugin,
  WireModuleShape,
} from "@covel/ai-provider";
import type {
  HookEnforce,
  HookEventName,
  KernelExtensionPointId,
  KernelExtensionPointIo,
  RpcTrustLevel,
} from "@covel/shared";
import type {
  shortId,
  shortIdBatch,
  tool,
  withPendingProposals,
  withModelView,
  ToolModule,
} from "@covel/tools";
import type { z, ZodType } from "zod";
import type { HookHandler } from "./hooks/types.js";
import type { FormValidator } from "./rpc/form-validator.js";
import type { RpcHandler } from "./rpc/rpc-registry.js";

/**
 * Pure helpers for entry factories. State reads belong to a tool's invocation
 * context; writes are proposals or request-scoped RPC operations.
 */
export interface PluginToolkit {
  readonly tool: typeof tool;
  readonly z: typeof z;
  readonly shortId: typeof shortId;
  readonly shortIdBatch: typeof shortIdBatch;
  readonly withModelView: typeof withModelView;
  readonly ToolError: typeof import("@covel/shared").ToolError;
  readonly withPendingProposals: typeof withPendingProposals;
}

export interface PluginHookOptions {
  /** Payload predicate — handler only fires when it returns true. */
  readonly match?: (payload: unknown) => boolean;
  readonly timeoutMs?: number;
  readonly enforce?: HookEnforce;
}

export type PluginJsonValue =
  | string
  | number
  | boolean
  | null
  | readonly PluginJsonValue[]
  | { readonly [key: string]: PluginJsonValue };

export interface PluginInstanceDataEntry {
  readonly key: string;
  readonly value: unknown;
  readonly updatedAt?: string;
}

export interface PluginInstanceDataStore {
  get(namespace: string, key: string): Promise<unknown>;
  list(namespace: string): Promise<readonly PluginInstanceDataEntry[]>;
  set(namespace: string, key: string, value: PluginJsonValue): Promise<void>;
  delete(namespace: string, key: string): Promise<boolean>;
}

export interface PluginSecretEntry<
  T extends PluginJsonValue = PluginJsonValue,
> {
  readonly value: T;
  readonly generation: number;
  readonly updatedAt: string;
}

export interface PluginSecretSummary {
  readonly key: string;
  readonly generation: number;
  readonly updatedAt: string;
}

export interface PluginSecretStore {
  get<T extends PluginJsonValue = PluginJsonValue>(
    key: string,
  ): Promise<PluginSecretEntry<T> | null>;
  list(): Promise<readonly PluginSecretSummary[]>;
  set<T extends PluginJsonValue = PluginJsonValue>(
    key: string,
    value: T,
  ): Promise<PluginSecretEntry<T>>;
  delete(key: string): Promise<boolean>;
  compareAndSwap<T extends PluginJsonValue = PluginJsonValue>(
    key: string,
    expectedGeneration: number | null,
    nextValue: T,
  ): Promise<
    | { readonly ok: true; readonly entry: PluginSecretEntry<T> }
    | {
        readonly ok: false;
        readonly reason: "generation_mismatch";
        readonly current: PluginSecretEntry<PluginJsonValue> | null;
      }
  >;
  withLock<TResult>(
    key: string,
    fn: (
      current: PluginSecretEntry<PluginJsonValue> | null,
    ) => Promise<TResult>,
  ): Promise<TResult>;
}

export interface PluginSandboxWorkerRunner {
  run<I = unknown, O = unknown>(params: {
    readonly code: string;
    readonly input: I;
    readonly timeoutMs?: number;
    readonly maxOutputBytes?: number;
    readonly signal?: AbortSignal;
  }): Promise<O>;
}

export interface PluginSchedulerClient {
  scheduleOnce(taskId: string, delayMs: number): Promise<void>;
}

export type PluginAppEventName =
  | "AppStarted"
  | "BeforeShutdown"
  | "SessionCreated"
  | "SessionTurnCommitted"
  | "SessionDeleted"
  | "WorldInstalled"
  | "WorldRemoved";

export interface PluginAppEventPayloads {
  readonly AppStarted: { readonly hostId?: string; readonly startedAt: string };
  readonly BeforeShutdown: {
    readonly hostId?: string;
    readonly reason: string;
  };
  readonly SessionCreated: {
    readonly sessionId: string;
    readonly worldId: string;
    readonly locale: string;
  };
  readonly SessionTurnCommitted: {
    readonly sessionId: string;
    readonly turnId: string;
    readonly logicalTurn: number;
    readonly committedAt: string;
  };
  readonly SessionDeleted: { readonly sessionId: string };
  readonly WorldInstalled: {
    readonly worldId: string;
    readonly source?: string;
  };
  readonly WorldRemoved: { readonly worldId: string };
}

export interface PluginAppEventContext {
  readonly signal: AbortSignal;
  readonly pluginId: string;
  readonly event: PluginAppEventName;
  readonly hostId?: string;
  readonly instanceData?: PluginInstanceDataStore;
  readonly secrets?: PluginSecretStore;
  readonly http: {
    readonly fetchWithRetry: typeof fetchWithRetry;
    readonly validateBaseUrl: typeof validateBaseUrlForPlugin;
  };
}

export type PluginAppEventHandler<
  E extends PluginAppEventName = PluginAppEventName,
> = (
  payload: PluginAppEventPayloads[E],
  context: PluginAppEventContext,
) => void | Promise<void>;

export interface PluginScheduledTaskContext {
  readonly signal: AbortSignal;
  readonly pluginId: string;
  readonly taskId: string;
  readonly hostId?: string;
  readonly instanceData?: PluginInstanceDataStore;
  readonly secrets?: PluginSecretStore;
  readonly sandbox?: PluginSandboxWorkerRunner;
  readonly http: {
    readonly fetchWithRetry: typeof fetchWithRetry;
    readonly validateBaseUrl: typeof validateBaseUrlForPlugin;
  };
}

export type PluginScheduledTaskHandler = (
  context: PluginScheduledTaskContext,
) => void | Promise<void>;

export interface PluginAppActionContext {
  readonly signal: AbortSignal;
  readonly pluginId: string;
  readonly action: string;
  readonly hostId?: string;
  readonly instanceData?: PluginInstanceDataStore;
  readonly secrets?: PluginSecretStore;
  readonly sandbox?: PluginSandboxWorkerRunner;
  readonly scheduler?: PluginSchedulerClient;
  readonly http: {
    readonly fetchWithRetry: typeof fetchWithRetry;
    readonly validateBaseUrl: typeof validateBaseUrlForPlugin;
  };
}

export type PluginAppActionHandler<I = unknown, O = unknown> = (
  input: I,
  context: PluginAppActionContext,
) => O | Promise<O>;

export interface PluginAppActionOptions<I = unknown, O = unknown> {
  readonly description?: string;
  readonly inputSchema?: ZodType<I>;
  readonly outputSchema?: ZodType<O>;
  readonly requiredCapabilities?: readonly string[];
}

export type PluginConfigFlowStepKind =
  "form" | "browser" | "device" | "import" | "confirm" | "done" | "error";

export type PluginConfigFlowText = string | Record<string, string>;

export interface PluginConfigFlowFieldOption {
  value: string;
  label: PluginConfigFlowText;
}

export interface PluginConfigFlowField {
  name: string;
  label: PluginConfigFlowText;
  type: "text" | "secret" | "url" | "number" | "boolean" | "select";
  required?: boolean;
  placeholder?: PluginConfigFlowText;
  description?: PluginConfigFlowText;
  defaultValue?: string | number | boolean;
  options?: PluginConfigFlowFieldOption[];
}

export type PluginConfigFlowStep =
  | {
      kind: "form";
      stepId: string;
      title: PluginConfigFlowText;
      description?: PluginConfigFlowText;
      fields: PluginConfigFlowField[];
      submitLabel?: PluginConfigFlowText;
    }
  | {
      kind: "browser";
      stepId: string;
      title: PluginConfigFlowText;
      description?: PluginConfigFlowText;
      authorizeUrl: string;
      completion: "loopback-or-paste" | "paste" | "loopback";
      callbackUrl?: string;
      expiresAt?: string;
    }
  | {
      kind: "device";
      stepId: string;
      title: PluginConfigFlowText;
      description?: PluginConfigFlowText;
      userCode: string;
      verificationUri: string;
      verificationUriComplete?: string;
      intervalSec?: number;
      expiresAt?: string;
    }
  | {
      kind: "import";
      stepId: string;
      title: PluginConfigFlowText;
      description?: PluginConfigFlowText;
      accept?: string;
      maxBytes?: number;
      placeholder?: PluginConfigFlowText;
    }
  | {
      kind: "confirm";
      stepId: string;
      title: PluginConfigFlowText;
      description?: PluginConfigFlowText;
      confirmLabel?: PluginConfigFlowText;
      cancelLabel?: PluginConfigFlowText;
      destructive?: boolean;
      details?: { label: PluginConfigFlowText; value: string }[];
    }
  | {
      kind: "done";
      title: PluginConfigFlowText;
      description?: PluginConfigFlowText;
      summary?: Record<string, unknown>;
      refreshSections?: string[];
    }
  | {
      kind: "error";
      code?: string;
      title: PluginConfigFlowText;
      message: PluginConfigFlowText;
      retryable?: boolean;
    };

export interface PluginLoopbackCallbackResult {
  readonly callbackUrl: string;
  readonly query: Readonly<Record<string, string>>;
}

export interface PluginLoopbackCallbackSession {
  readonly callbackUrl: string;
  readonly port: number;
  waitForCallback(): Promise<PluginLoopbackCallbackResult>;
  close(): Promise<void>;
}

export interface PluginConfigFlowContext {
  readonly signal: AbortSignal;
  readonly pluginId: string;
  readonly flowId: string;
  readonly runId: string;
  readonly hostId?: string;
  readonly instanceData?: PluginInstanceDataStore;
  readonly secrets?: PluginSecretStore;
  readonly sandbox?: PluginSandboxWorkerRunner;
  readonly http: {
    readonly fetchWithRetry: typeof fetchWithRetry;
    readonly validateBaseUrl: typeof validateBaseUrlForPlugin;
  };
  startLoopbackCallback?(): Promise<PluginLoopbackCallbackSession>;
}

export interface PluginConfigFlowStartInput {
  readonly initial?: PluginJsonValue;
}

export interface PluginConfigFlowStepInput {
  readonly stepId: string;
  readonly data?: Record<string, unknown>;
  readonly callbackUrl?: string;
  readonly cancelled?: boolean;
}

export interface PluginConfigFlowDefinition {
  readonly description?: string;
  readonly requiredCapabilities?: readonly string[];
  start(
    input: PluginConfigFlowStartInput,
    context: PluginConfigFlowContext,
  ): PluginConfigFlowStep | Promise<PluginConfigFlowStep>;
  step(
    input: PluginConfigFlowStepInput,
    context: PluginConfigFlowContext,
  ): PluginConfigFlowStep | Promise<PluginConfigFlowStep>;
  poll?(
    context: PluginConfigFlowContext,
  ): PluginConfigFlowStep | null | Promise<PluginConfigFlowStep | null>;
  cancel?(context: PluginConfigFlowContext): void | Promise<void>;
}

export interface PluginProviderSourceContext {
  readonly signal: AbortSignal;
  readonly pluginId: string;
  readonly sourceId: string;
  readonly hostId?: string;
  readonly secrets?: PluginSecretStore;
  readonly instanceData?: PluginInstanceDataStore;
  readonly sandbox?: PluginSandboxWorkerRunner;
  readonly http: {
    readonly fetchWithRetry: typeof fetchWithRetry;
    readonly validateBaseUrl: typeof validateBaseUrlForPlugin;
  };
}

export interface PluginProviderSourceResolveRequest {
  readonly mode: import("@covel/shared/platform").ProviderSourceMode;
  readonly model: string;
  readonly accountId?: string;
}

export interface PluginProviderSourceResolved {
  readonly baseUrl?: string;
  readonly protocol?: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly accountId?: string;
  readonly credentialGeneration?: number;
  readonly requestShape?: import("@covel/shared/platform").ProviderSourceRequestShape;
}

export interface PluginProviderSourceRefreshRequest {
  readonly accountId?: string;
  readonly failedGeneration?: number;
  readonly statusCode: number;
}

export interface PluginProviderSourceErrorClassification {
  readonly kind: import("@covel/shared").ProviderFailureKind;
  readonly retryAfterMs?: number;
  readonly message?: string;
}

export interface PluginProviderSource {
  readonly id: string;
  resolve(
    request: PluginProviderSourceResolveRequest,
    context: PluginProviderSourceContext,
  ): Promise<PluginProviderSourceResolved>;
  refresh?(
    request: PluginProviderSourceRefreshRequest,
    context: PluginProviderSourceContext,
  ): Promise<PluginProviderSourceResolved | null>;
  listAccounts?(
    context: PluginProviderSourceContext,
  ): Promise<
    readonly import("@covel/shared/platform").ProviderSourceAccountSummary[]
  >;
  listModels?(
    request: { readonly accountId?: string },
    context: PluginProviderSourceContext,
  ): Promise<readonly string[]>;
  getUsage?(
    request: { readonly accountId?: string },
    context: PluginProviderSourceContext,
  ): Promise<
    import("@covel/shared/platform").ProviderSourceUsageSummary | null
  >;
  classifyError?(error: {
    readonly statusCode?: number;
    readonly body?: unknown;
    readonly message: string;
  }): PluginProviderSourceErrorClassification | null | undefined;
}

export interface PluginRpcOptions {
  readonly description?: string;
  /** May only restrict (never escalate) the plugin's source trust. */
  readonly trustLevel?: RpcTrustLevel;
}

/**
 * The facade an entry factory receives. Registrations are staged until all
 * entries of this plugin succeed, then published as one synchronous batch.
 * Register only while the factory is running; late registrations are rejected.
 * Initialization failures discard the batch and permit a later activation retry.
 */
export interface PluginAPI {
  /** Activation lifetime, aborted on initialization failure or host shutdown. */
  readonly signal: AbortSignal;
  /** Release factory-created resources on rollback or shutdown, in reverse order. */
  onDispose(cleanup: () => void | Promise<void>): void;
  /** Publish a reusable function; callers receive validated values, never private plugin state. */
  registerService<I, O>(
    definition: import("@covel/shared/plugin-runtime").PluginServiceDefinition<
      I,
      O
    >,
  ): void;
  /**
   * Implement a kernel-owned point declared by this plugin's manifest. Known
   * versioned point ids bind the handler's input/output types from
   * `KernelExtensionPointIo`.
   */
  provideExtension<P extends KernelExtensionPointId>(
    point: P,
    id: string,
    definition: import("@covel/shared").PluginExtensionDefinition<
      KernelExtensionPointIo[P]["input"],
      KernelExtensionPointIo[P]["output"]
    >,
  ): void;
  readonly pluginId: string;
  readonly toolkit: PluginToolkit;
  readonly hostId?: string;
  readonly instanceData?: PluginInstanceDataStore;
  readonly secrets?: PluginSecretStore;
  readonly sandbox?: PluginSandboxWorkerRunner;
  /** SSRF-guarded fetch helpers for wire implementations. */
  readonly http: {
    readonly fetchWithRetry: typeof fetchWithRetry;
    readonly validateBaseUrl: typeof validateBaseUrlForPlugin;
  };
  /** Register a local tool scoped to this plugin. */
  registerTool(toolModule: ToolModule): void;
  /** Register a lifecycle hook handler (17 events, same semantics as `hooks`). */
  on(
    event: HookEventName,
    handler: HookHandler,
    options?: PluginHookOptions,
  ): void;
  /** Register an RPC action with an inline handler (same gate as `rpc`). */
  registerRpc(
    action: string,
    handler: RpcHandler,
    options?: PluginRpcOptions,
  ): void;
  /** Register an instance-scoped application action (`POST /api/plugins/:pluginId/actions/:action`). */
  registerAppAction<I = unknown, O = unknown>(
    action: string,
    handler: PluginAppActionHandler<I, O>,
    options?: PluginAppActionOptions<I, O>,
  ): void;
  /** Register a declarative multi-step configuration / authentication flow. */
  registerConfigFlow(
    flowId: string,
    definition: PluginConfigFlowDefinition,
  ): void;
  /** Subscribe to a read-only application lifecycle event (`contributes.appEvents`). */
  onAppEvent<E extends PluginAppEventName>(
    event: E,
    handler: PluginAppEventHandler<E>,
  ): void;
  /** Register a handler for a bounded periodic task declared under `contributes.schedules`. */
  registerScheduledTask(
    taskId: string,
    handler: PluginScheduledTaskHandler,
  ): void;
  /** Validate this plugin's committed forms before accepting input; return an error or undefined. */
  registerFormValidator(name: string, validator: FormValidator): void;
  /** Register media wires (namespaced `<pluginId>/<wireId>`, like `wires`). */
  registerWires(wires: WireModuleShape): void;
  /** Register declarative provider credential/connection sources (`contributes.providerSources`). */
  registerProviderSources(sources: readonly PluginProviderSource[]): void;
}

/** Signature of an entry module's default export. */
export type PluginEntryFactory = (covel: PluginAPI) => void | Promise<void>;
