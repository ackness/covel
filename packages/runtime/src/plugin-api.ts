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
  ProviderFailureKind,
  RpcTrustLevel,
} from "@covel/shared";
import type {
  AppEventName,
  AppEventPayloadMap,
  ChannelBridgeInput,
  ChannelBridgeOutput,
  ConfigFlowField,
  ConfigFlowStep,
  ConfigFlowStepKind,
  PlatformText,
  PluginConfigFlowFieldOption,
  PluginConfigFlowStartInput,
  PluginConfigFlowStepInput,
  PluginInstanceDataEntry,
  PluginInstanceDataStore,
  PluginJsonValue,
  PluginLoopbackCallbackResult,
  PluginLoopbackCallbackSession,
  PluginProviderSourceRefreshRequest,
  PluginSandboxWorkerRunner,
  PluginSchedulerClient,
  PluginSecretEntry,
  PluginSecretStore,
  PluginSecretSummary,
  ProviderSourceAccountSummary,
  ProviderSourceMode,
  ProviderSourceRequestShape,
  ProviderSourceUsageSummary,
} from "@covel/shared/platform";
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

export type {
  PluginConfigFlowFieldOption,
  PluginConfigFlowStartInput,
  PluginConfigFlowStepInput,
  PluginInstanceDataEntry,
  PluginInstanceDataStore,
  PluginJsonValue,
  PluginLoopbackCallbackResult,
  PluginLoopbackCallbackSession,
  PluginProviderSourceRefreshRequest,
  PluginSandboxWorkerRunner,
  PluginSchedulerClient,
  PluginSecretEntry,
  PluginSecretStore,
  PluginSecretSummary,
};

type PluginRuntimeHttp = {
  readonly fetchWithRetry: typeof fetchWithRetry;
  readonly validateBaseUrl: typeof validateBaseUrlForPlugin;
};

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

export type PluginAppEventName = AppEventName;
export type PluginAppEventPayloads = AppEventPayloadMap;

export interface PluginAppEventContext {
  readonly signal: AbortSignal;
  readonly pluginId: string;
  readonly event: PluginAppEventName;
  readonly hostId?: string;
  readonly instanceData?: PluginInstanceDataStore;
  readonly secrets?: PluginSecretStore;
  readonly http: PluginRuntimeHttp;
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
  readonly http: PluginRuntimeHttp;
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
  readonly http: PluginRuntimeHttp;
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

export type PluginConfigFlowStepKind = ConfigFlowStepKind;
export type PluginConfigFlowText = PlatformText;
export type PluginConfigFlowField = ConfigFlowField;
export type PluginConfigFlowStep = ConfigFlowStep;

export interface PluginConfigFlowContext {
  readonly signal: AbortSignal;
  readonly pluginId: string;
  readonly flowId: string;
  readonly runId: string;
  readonly hostId?: string;
  readonly instanceData?: PluginInstanceDataStore;
  readonly secrets?: PluginSecretStore;
  readonly sandbox?: PluginSandboxWorkerRunner;
  readonly http: PluginRuntimeHttp;
  startLoopbackCallback?(): Promise<PluginLoopbackCallbackSession>;
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
  readonly http: PluginRuntimeHttp;
}

export interface PluginProviderSourceResolveRequest {
  readonly mode: ProviderSourceMode;
  readonly model: string;
  readonly accountId?: string;
}

export interface PluginProviderSourceResolved {
  readonly baseUrl?: string;
  readonly protocol?: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly accountId?: string;
  readonly credentialGeneration?: number;
  readonly requestShape?: ProviderSourceRequestShape;
}

export interface PluginProviderSourceErrorClassification {
  readonly kind: ProviderFailureKind;
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
  ): Promise<readonly ProviderSourceAccountSummary[]>;
  listModels?(
    request: { readonly accountId?: string },
    context: PluginProviderSourceContext,
  ): Promise<readonly string[]>;
  getUsage?(
    request: { readonly accountId?: string },
    context: PluginProviderSourceContext,
  ): Promise<ProviderSourceUsageSummary | null>;
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
  dispatchChannelBridge?(
    input: ChannelBridgeInput,
    options?: { readonly locale?: string; readonly signal?: AbortSignal },
  ): Promise<readonly ChannelBridgeOutput[]>;
  /** SSRF-guarded fetch helpers for wire implementations. */
  readonly http: PluginRuntimeHttp;
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
