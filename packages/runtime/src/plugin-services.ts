import {
  TURN_POLICY_CONTRACT,
  CHARACTER_ACTOR_CONTRACT,
  turnPolicyRequestSchema,
  turnPolicyInputSchema,
  validateTurnPolicyOutput,
  turnPolicyModelInputSchema,
} from "@covel/shared";
import { DelegationBudget } from "./orchestration/delegation-budget.js";
import {
  compareText,
  pluginMessagesFor,
  type PluginMessageCatalog,
} from "@covel/shared";
import { toolParametersJsonSchema } from "@covel/tools";
import { AsyncLocalStorage } from "node:async_hooks";
import type {
  PluginServiceClient,
  PluginServiceContext,
  PluginServiceDefinition,
  PluginServiceDescriptor,
  PluginWriteServiceContext,
} from "@covel/shared/plugin-runtime";
import { ToolError, type Proposal } from "@covel/shared";
import type {
  ExtensionDeclaration,
  ExtensionPoint,
  ExtensionProviderDescriptor,
  PluginExtensionContext,
  PluginExtensionDefinition,
} from "@covel/shared";
import {
  withDefaultGatewaySignal,
  withDefaultUtilsSignal,
} from "./function-runtime/runtime-abort-boundaries.js";
import type { TurnEmitter } from "./trace/turn-emitter.js";
import { withGatewayTrace } from "./function-runtime/gateway-trace.js";
import { currentOwnSettings } from "./hooks/hook-scope.js";
import {
  providerVisibility,
  readProviderData,
  type PluginDataVisibility,
} from "./function-runtime/upstream-plugin-data.js";
import { createServicePluginDataWriter } from "./function-runtime/plugin-handler-helpers.js";
import { createExecutionWriteBuffer } from "./function-runtime/execution-write-buffer.js";
import { createPluginRandom } from "./function-runtime/plugin-random.js";
import type {
  OperationStage,
  StagedOperation,
} from "./operations/operation-stage.js";

/** Fixed answers of a write call that cannot run where it was made. */
export const WRITE_SERVICE_MESSAGES = Object.freeze({
  noStage: "Write services cannot be called here.",
  nestedWrite: "A write service cannot call another write service.",
  nestedInRead: "A read service cannot call a write service.",
  selfCall:
    "A plugin changes its own data directly, not through its own write service.",
  datasets:
    "The write service is unavailable: its plugin's data rules could not be loaded.",
});

class ServiceOutputValidationError extends Error {
  constructor() {
    super("Plugin service output failed validation");
  }
}

/** The provider's input parser rejected the call's input. */
export class ServiceInputValidationError extends Error {
  /** `path: message` of each problem the parser reported, when it says. */
  readonly details: readonly string[];
  constructor(cause: unknown) {
    super("Plugin service input failed validation", { cause });
    this.name = "ServiceInputValidationError";
    const issues =
      cause && typeof cause === "object" && "issues" in cause
        ? (cause as { issues?: unknown }).issues
        : undefined;
    this.details = Array.isArray(issues)
      ? issues.flatMap((issue: unknown) => {
          if (!issue || typeof issue !== "object") return [];
          const { path, message } = issue as {
            path?: unknown;
            message?: unknown;
          };
          if (typeof message !== "string") return [];
          const at = Array.isArray(path) && path.length ? path.join(".") : "";
          return [at ? `${at}: ${message}` : message];
        })
      : [];
  }
}

interface Entry extends PluginServiceDescriptor {
  readonly access: "read" | "write";
  readonly extension?: ExtensionDeclaration;
  /** Set for a model-facing service: the schema its imported tool shows. */
  readonly modelFacing?: {
    readonly jsonSchema: Readonly<Record<string, unknown>>;
    readonly input: { parse(value: unknown): unknown };
  };
  invoke(
    input: unknown,
    context: PluginServiceContext | PluginWriteServiceContext,
  ): Promise<unknown>;
}

/** How an agent's import of a contract resolves for one run. */
export type ServiceImportResolution =
  | {
      readonly status: "ready";
      readonly pluginId: string;
      readonly name: string;
      readonly contract: string;
      /** `write`: a call stages the provider's writes for the caller. */
      readonly access: "read" | "write";
      readonly description: string;
      readonly jsonSchema: Readonly<Record<string, unknown>>;
      /** The provider's own parser; the imported tool checks arguments with it. */
      readonly input: { parse(value: unknown): unknown };
    }
  /** No active provider offers the contract. */
  | { readonly status: "missing" }
  /** Providers exist, but none offers the contract to models. */
  | {
      readonly status: "not-model-facing";
      readonly providers: readonly string[];
    }
  /** More than one provider offers it to models; none is chosen. */
  | { readonly status: "ambiguous"; readonly providers: readonly string[] }
  /** The one provider is paused after repeated errors. */
  | { readonly status: "paused"; readonly pluginId: string };

type ExtensionContextFields = Pick<
  PluginExtensionContext,
  "sessionId" | "locale" | "turnId" | "pluginData"
>;

export interface KernelServiceCaller extends Omit<Caller, "pluginId"> {
  /** Host-only capability. Nested plugin service calls never inherit it. */
  extensionContext(
    pluginId: string,
    signal: AbortSignal,
  ): ExtensionContextFields;
}

export interface ServiceCallOutcome {
  readonly providerPluginId: string;
  readonly callerRuntimeId?: string;
  /**
   * The scheduled runtime a sub-agent made the call for. Absent when the
   * caller is that runtime itself. A setup runtime's exemption follows it.
   */
  readonly originRuntimeId?: string;
  readonly verdict: "fault" | "clean" | "neutral";
}

function providerVerdict(
  code: PluginServiceCallEvent["errorCode"],
  error: unknown,
  ownImportTimeout: boolean,
): ServiceCallOutcome["verdict"] {
  if (serviceFailureOf(error)) return "neutral";
  const deliberate =
    error instanceof ToolError &&
    [
      "invalid-input",
      "not-found",
      "ambiguous",
      "refused",
      "conflict",
      "unavailable",
      "cancelled",
    ].includes(error.code);
  return code === "output-validation" ||
    (code === "invocation-error" && !deliberate) ||
    (code === "timeout" && ownImportTimeout)
    ? "fault"
    : "neutral";
}

interface Caller {
  readonly delegation?: DelegationBudget;
  /** Kernel-only execution collector; inherited by nested service clients. */
  readonly onSettled?: (outcome: ServiceCallOutcome) => void;
  /** Host-owned trace destination; never exposed in the plugin context. */
  readonly emitter?: TurnEmitter;
  readonly sessionId: string;
  readonly pluginId: string;
  readonly turnId?: string;
  readonly runtimeId?: string;
  /** The tool call that made this call; nested calls inherit it. */
  readonly toolCallId?: string;
  readonly signal: AbortSignal;
  readonly gateway?: PluginServiceContext["gateway"];
  readonly utils?: PluginServiceContext["utils"];
  /** Kernel-only read scope, inherited unchanged through nested calls. */
  readonly reads?: {
    readonly locale?: string;
    readonly world?: PluginServiceContext["world"];
    readonly store?: Pick<
      import("@covel/store").DataStore,
      "getPluginData" | "listPluginData"
    >;
    readonly visibility?: PluginDataVisibility;
    readonly writeBuffer?: readonly import("@covel/shared").Proposal[];
  };
  /**
   * Kernel only: the stage a write-service call stages into. Without it a
   * write service answers `unavailable`. Read services read what it staged.
   */
  readonly operations?: OperationStage;
  /**
   * Kernel only: set for calls made from inside a service handler, which
   * reach read services only.
   */
  readonly nestedIn?: "read" | "write";
}

export interface PluginServiceCallEvent {
  readonly extension?: Pick<ExtensionDeclaration, "point" | "id" | "slot">;
  readonly sessionId: string;
  /** Opaque host admission scope; inherited by nested calls once known. */
  readonly diagnosticScope?: string;
  readonly turnId?: string;
  readonly runtimeId?: string;
  /** The tool call that made the call, for calls made from a tool. */
  readonly toolCallId?: string;
  readonly callId: string;
  readonly parentCallId?: string;
  readonly callerPluginId: string;
  readonly providerPluginId: string;
  readonly name: string;
  readonly contract: string;
  readonly durationMs: number;
  readonly outcome: "success" | "timeout" | "cancelled" | "error";
  /** Fixed classifications only; never provider errors or call payloads. */
  readonly errorCode?:
    | "invalid-options"
    | "cycle-or-depth-limit"
    | "admission-error"
    | "unavailable"
    | "input-validation"
    | "invocation-error"
    | "output-validation"
    | "timeout"
    | "cancelled";
}

export type ServiceFailure = Pick<
  PluginServiceCallEvent,
  "callerPluginId" | "providerPluginId"
> & { readonly errorCode: NonNullable<PluginServiceCallEvent["errorCode"]> };

// Keep exception identity (including provider details and cancellation reasons)
// while carrying host-owned provenance to runtime finalization. Nested calls
// retain the original failing hop rather than blaming an intermediate caller.
const serviceFailures = new WeakMap<object, ServiceFailure>();

export function serviceFailureOf(error: unknown): ServiceFailure | undefined {
  return typeof error === "object" && error !== null
    ? serviceFailures.get(error)
    : undefined;
}

/**
 * Kernel only: attach service provenance to an error, so a caller's failure
 * caused by a provider is attributed to the provider. The first tag wins.
 */
export function tagServiceFailure(
  error: unknown,
  failure: ServiceFailure,
): unknown {
  // Box primitive throws so they can carry the same provenance as Error throws.
  const tagged =
    typeof error === "object" && error !== null
      ? error
      : new Error(String(error), { cause: error });
  if (!serviceFailures.has(tagged)) serviceFailures.set(tagged, failure);
  return tagged;
}

interface CallState {
  readonly callId: string;
  diagnosticScope?: string;
  cancellation?: "timeout" | "cancelled";
  ownTimeout?: boolean;
}

async function runCall(
  parentSignal: AbortSignal,
  options: Parameters<PluginServiceClient["call"]>[1],
  invoke: (signal: AbortSignal) => Promise<unknown>,
  state: CallState,
  parentState?: CallState,
): Promise<unknown> {
  if (options !== undefined && (!options || typeof options !== "object"))
    throw new TypeError("Service call options must be an object");
  const timeoutMs = options?.timeoutMs;
  if (
    timeoutMs !== undefined &&
    (typeof timeoutMs !== "number" ||
      !Number.isFinite(timeoutMs) ||
      timeoutMs <= 0 ||
      timeoutMs > 2_147_483_647)
  )
    throw new TypeError(
      "Service timeoutMs must be positive and at most 2147483647",
    );
  if (options?.signal !== undefined && !(options.signal instanceof AbortSignal))
    throw new TypeError("Service signal must be an AbortSignal");

  const controller = new AbortController();
  const cleanups: (() => void)[] = [];
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    for (const signal of new Set([parentSignal, options?.signal])) {
      if (!signal) continue;
      const relay = () => {
        if (controller.signal.aborted) return;
        state.cancellation =
          signal === parentSignal
            ? (parentState?.cancellation ?? "cancelled")
            : "cancelled";
        controller.abort(signal.reason);
      };
      if (signal.aborted) relay();
      else {
        signal.addEventListener("abort", relay, { once: true });
        cleanups.push(() => signal.removeEventListener("abort", relay));
      }
    }
    controller.signal.throwIfAborted();
    if (timeoutMs !== undefined)
      timer = setTimeout(() => {
        if (controller.signal.aborted) return;
        state.cancellation = "timeout";
        state.ownTimeout = true;
        controller.abort(
          new DOMException("Plugin service call timed out", "TimeoutError"),
        );
      }, timeoutMs);
    const aborted = new Promise<never>((_resolve, reject) => {
      const onAbort = () => reject(controller.signal.reason);
      controller.signal.addEventListener("abort", onAbort, { once: true });
      cleanups.push(() =>
        controller.signal.removeEventListener("abort", onAbort),
      );
    });
    // Observe losing work so a late rejection cannot become unhandled.
    return await Promise.race([invoke(controller.signal), aborted]);
  } finally {
    clearTimeout(timer);
    for (const cleanup of cleanups) cleanup();
    // A retained service context cannot outlive this call and spend the
    // caller's remaining budget after the caller has already moved on.
    controller.abort(new Error("Plugin service call completed"));
  }
}

function isParser(value: unknown): value is { parse(value: unknown): unknown } {
  return Boolean(
    value &&
    typeof value === "object" &&
    "parse" in value &&
    typeof value.parse === "function",
  );
}

/**
 * A service may compute with the caller's model access, but `resolveSlot`
 * must not hand it key material. Rebuild the result as the declared
 * `ResolvedSlotForPlugin` shape rather than blacklisting fields: `apiKey`
 * and auth-bearing `headers` are credential material, and the runtime
 * result also carries undeclared extras (`capability`,
 * `parameterOverrides`) that a lent context has no contract for.
 * `metadata` and the projected `limits` stay — they are declared
 * plugin-facing configuration, not a credential channel. Model calls still
 * work through generateText / evaluate, which never expose credentials.
 */
function lendGateway(
  gateway: PluginServiceContext["gateway"],
): PluginServiceContext["gateway"] {
  if (!gateway) return gateway;
  return {
    ...gateway,
    resolveSlot: (input) => {
      const resolved = gateway.resolveSlot(input);
      if (!resolved) return resolved;
      return {
        presetId: resolved.presetId,
        provider: resolved.provider,
        protocol: resolved.protocol,
        ...(resolved.baseUrl !== undefined
          ? { baseUrl: resolved.baseUrl }
          : {}),
        model: resolved.model,
        tag: resolved.tag,
        metadata: resolved.metadata,
        ...(resolved.limits ? { limits: resolved.limits } : {}),
      };
    },
  };
}

/**
 * The JSON Schema a model-facing service's imported tool shows. Checked at
 * registration, so a bad declaration fails the entry, not a later turn.
 */
function modelFacingSchema(
  definition: Pick<
    PluginServiceDefinition<unknown, unknown>,
    "name" | "description" | "inputSchema" | "input"
  >,
): Readonly<Record<string, unknown>> {
  const service = `Model-facing service "${definition.name}"`;
  if (
    typeof definition.description !== "string" ||
    !definition.description.trim()
  )
    throw new Error(`${service} requires a description`);
  let schema: unknown;
  if (definition.inputSchema !== undefined) {
    schema = definition.inputSchema;
  } else {
    const input = definition.input as {
      toJSONSchema?: (params: { io: "input" }) => Record<string, unknown>;
    };
    if (typeof input.toJSONSchema !== "function")
      throw new Error(
        `${service} requires a Zod input or an explicit inputSchema`,
      );
    try {
      schema = toolParametersJsonSchema(
        input as Parameters<typeof toolParametersJsonSchema>[0],
      );
    } catch (cause) {
      throw new Error(
        `${service}: its input cannot be represented as JSON Schema: ${cause instanceof Error ? cause.message : String(cause)}`,
        { cause },
      );
    }
  }
  if (
    !schema ||
    typeof schema !== "object" ||
    Array.isArray(schema) ||
    (schema as { type?: unknown }).type !== "object"
  )
    throw new Error(`${service}: its input schema root must be type "object"`);
  let copy: Record<string, unknown>;
  try {
    copy = structuredClone(schema as Record<string, unknown>);
  } catch (cause) {
    throw new Error(`${service}: its input schema must be plain JSON`, {
      cause,
    });
  }
  return Object.freeze(copy);
}

/** Scoped to one host instance; activation owns registration disposal. */
export class PluginServiceRegistry {
  private readonly executionObservers = new AsyncLocalStorage<
    (outcome: ServiceCallOutcome) => void
  >();
  private readonly importedCalls = new AsyncLocalStorage<boolean>();

  /** Bind execution collection without exposing the observer to plugin code. */
  withExecutionObserver<T>(
    observer: (outcome: ServiceCallOutcome) => void,
    run: () => T,
  ): T {
    return this.executionObservers.run(observer, run);
  }

  executionObserver(): ((outcome: ServiceCallOutcome) => void) | undefined {
    return this.executionObservers.getStore();
  }

  /** Generated tools are kernel service imports; plugin tools choose their own deadlines. */
  observeToolCalls(
    inner: import("./agent-loop/tool-executor.js").ToolExecutor,
  ): import("./agent-loop/tool-executor.js").ToolExecutor {
    return {
      getToolInfo: (name, context) => inner.getToolInfo(name, context),
      execute: (call, context) =>
        this.importedCalls.run(
          context.generatedTools?.has(call.name) === true,
          () => inner.execute(call, context),
        ),
    };
  }

  private readonly entries = new Map<string, Entry>();
  private readonly snapshots = new AsyncLocalStorage<Map<string, Entry>>();
  private readEntries(): ReadonlyMap<string, Entry> {
    return this.snapshots.getStore() ?? this.entries;
  }
  withSnapshot<T>(fn: () => T): T {
    return this.snapshots.getStore()
      ? fn()
      : this.snapshots.run(new Map(this.entries), fn);
  }
  replacePlugin<T>(pluginId: string, publish: () => T): T {
    const previous = [...this.entries].filter(
      ([, entry]) => entry.pluginId === pluginId,
    );
    for (const [key] of previous) this.entries.delete(key);
    try {
      return publish();
    } catch (error) {
      for (const [key, entry] of this.entries)
        if (entry.pluginId === pluginId) this.entries.delete(key);
      for (const [key, entry] of previous) this.entries.set(key, entry);
      throw error;
    }
  }

  constructor(
    private readonly admission: {
      /** Only active, approved plugins; may activate deferred entries. */
      list(sessionId: string): Promise<readonly string[]>;
      ensure(sessionId: string, pluginId: string): Promise<void | string>;
      /**
       * Active plugins paused after repeated errors: inside an execution the
       * set it started with. Imports count them so that a paused provider is
       * never silently replaced; without it paused providers are unknown.
       */
      paused?(sessionId: string): Promise<readonly string[]>;
      /** Host-owned observer; failures must never affect service execution. */
      onCallCompleted?(event: PluginServiceCallEvent): void | Promise<void>;
    },
    private readonly messagesOf?: (
      pluginId: string,
    ) => readonly PluginMessageCatalog[] | undefined,
  ) {}

  /** Host diagnostics only: registered descriptors, without handlers or parsers. */
  list(): readonly PluginServiceDescriptor[] {
    return [...this.readEntries().values()]
      .map(({ pluginId, name, contract, description }) => ({
        pluginId,
        name,
        contract,
        ...(description !== undefined ? { description } : {}),
      }))
      .sort((a, b) =>
        compareText(`${a.pluginId}/${a.name}`, `${b.pluginId}/${b.name}`),
      );
  }

  register<I, O>(
    pluginId: string,
    definition: PluginServiceDefinition<I, O>,
  ): () => void {
    return this.registerDefinition(pluginId, definition);
  }

  registerExtension<I, O>(
    pluginId: string,
    point: ExtensionPoint<I, O>,
    declaration: ExtensionDeclaration,
    definition: PluginExtensionDefinition<I, O>,
  ): () => void {
    if (
      point.id !== declaration.point ||
      !/^[a-zA-Z0-9][\w.-]*$/.test(declaration.id)
    )
      throw new Error("Invalid extension declaration");
    // A reserved service namespace prevents collisions with plugin services.
    const name = `__extension.${point.id}.${declaration.id}`;
    const registeredDeclaration = structuredClone(declaration);
    return this.registerDefinition(
      pluginId,
      {
        name,
        contract: point.id,
        input: point.input,
        output: {
          parse(value: unknown): O {
            const parsed = point.output.parse(value);
            return point.attributeOutput
              ? point.output.parse(
                  point.attributeOutput(parsed, {
                    ...structuredClone(registeredDeclaration),
                    pluginId,
                    name,
                  }),
                )
              : parsed;
          },
        },
        handler: (input, context) =>
          definition.handler(input, context as PluginExtensionContext),
      },
      registeredDeclaration,
    );
  }

  listExtensions(): readonly ExtensionProviderDescriptor[] {
    return [...this.readEntries().values()].flatMap((entry) =>
      entry.extension
        ? [
            {
              ...structuredClone(entry.extension),
              pluginId: entry.pluginId,
              name: entry.name,
            },
          ]
        : [],
    );
  }

  /** Kernel discovery uses the same active-and-approved admission list. */
  async discoverExtensions(
    sessionId: string,
    point: string,
  ): Promise<readonly ExtensionProviderDescriptor[]> {
    const active = new Set(await this.admission.list(sessionId));
    return this.listExtensions().filter(
      (entry) => entry.point === point && active.has(entry.pluginId),
    );
  }

  /** Only the host receives this client; plugin facades expose createClient. */
  createKernelClient(caller: KernelServiceCaller): PluginServiceClient {
    return this.createScopedClient(
      { ...caller, pluginId: "__kernel" },
      [],
      undefined,
      caller,
    );
  }

  private registerDefinition<I, O>(
    pluginId: string,
    definition: PluginServiceDefinition<I, O>,
    extension?: ExtensionDeclaration,
  ): () => void {
    if (
      !definition ||
      typeof definition !== "object" ||
      typeof definition.name !== "string" ||
      (!extension && !/^[a-zA-Z0-9][\w.-]*$/.test(definition.name)) ||
      typeof definition.contract !== "string" ||
      !definition.contract.trim()
    ) {
      throw new Error("Service requires a valid name and a versioned contract");
    }
    if (
      !isParser(definition.input) ||
      !isParser(definition.output) ||
      typeof definition.handler !== "function" ||
      (definition.description !== undefined &&
        typeof definition.description !== "string") ||
      (definition.modelFacing !== undefined &&
        typeof definition.modelFacing !== "boolean")
    )
      throw new TypeError(
        "Service requires input/output parsers, a handler, and an optional string description",
      );
    const access = (definition as { access?: unknown }).access ?? "read";
    if (access !== "read" && access !== "write")
      throw new TypeError('Service access must be "read" or "write"');
    if (
      definition.contract === CHARACTER_ACTOR_CONTRACT ||
      (definition.contract === TURN_POLICY_CONTRACT &&
        (access !== "read" || extension))
    )
      throw new TypeError(
        "turn-policy@1 requires a read service; character-actor@1 requires an agent runtime",
      );
    if (access === "write" && extension)
      throw new TypeError("An extension provider cannot be a write service");
    const modelFacing =
      definition.modelFacing === true && !extension
        ? modelFacingSchema(definition)
        : undefined;
    const key = `${pluginId}/${definition.name}`;
    if (this.entries.has(key))
      throw new Error(`Duplicate plugin service: ${key}`);
    const entry: Entry = {
      pluginId,
      name: definition.name,
      contract: definition.contract,
      description: definition.description,
      access,
      extension,
      ...(modelFacing
        ? { modelFacing: { jsonSchema: modelFacing, input: definition.input } }
        : {}),
      invoke: async (input, context) => {
        // The extension host validates kernel inputs before composition/caching.
        // Each provider still owns its input, including unknown schema fields.
        const detached = structuredClone(input);
        let parsed: I;
        try {
          const canonical =
            definition.contract === TURN_POLICY_CONTRACT
              ? turnPolicyInputSchema.parse(detached)
              : detached;
          parsed = extension
            ? (canonical as I)
            : definition.input.parse(canonical);
          if (definition.contract === TURN_POLICY_CONTRACT)
            turnPolicyInputSchema.parse(parsed);
        } catch (cause) {
          throw new ServiceInputValidationError(cause);
        }
        context.signal.throwIfAborted();
        const handler = definition.handler as (
          input: I,
          context: PluginServiceContext | PluginWriteServiceContext,
        ) => Promise<O> | O;
        const result = await handler(parsed, context);
        context.signal.throwIfAborted();
        try {
          if (definition.contract === TURN_POLICY_CONTRACT)
            validateTurnPolicyOutput(
              turnPolicyInputSchema.parse(input),
              result,
            );
          const output = definition.output.parse(result);
          return structuredClone(
            definition.contract === TURN_POLICY_CONTRACT
              ? validateTurnPolicyOutput(
                  turnPolicyInputSchema.parse(input),
                  output,
                )
              : output,
          );
        } catch {
          throw new ServiceOutputValidationError();
        }
      },
    };
    this.entries.set(key, entry);
    return () => {
      if (this.entries.get(key) === entry) this.entries.delete(key);
    };
  }

  /**
   * Kernel only: the one provider an agent's import of `contract` binds to
   * for a run. Candidates are model-facing entries whose plugin is active and
   * approved, or paused: a paused provider still counts, so the import is
   * never silently bound to another one.
   */
  private async resolveSelection(
    caller: Pick<Caller, "sessionId" | "pluginId" | "delegation">,
    contract: string,
    model: boolean,
  ): Promise<Entry | Exclude<ServiceImportResolution, { status: "ready" }>> {
    await this.admission.ensure(caller.sessionId, caller.pluginId);
    const admitted = new Set(await this.admission.list(caller.sessionId));
    const paused = new Set(
      (await this.admission.paused?.(caller.sessionId)) ?? [],
    );
    const entries = [...this.readEntries().values()].filter(
      (entry) =>
        !entry.extension &&
        entry.contract === contract &&
        (admitted.has(entry.pluginId) || paused.has(entry.pluginId)),
    );
    const selected =
      contract === TURN_POLICY_CONTRACT
        ? caller.delegation?.limits.turnPolicy
        : undefined;
    const eligible = selected
      ? entries.filter(
          (entry) =>
            entry.pluginId === selected.pluginId &&
            entry.name === selected.name,
        )
      : entries;
    // An explicit choice precedes model visibility. Other contracts retain
    // their model-facing-only automatic import resolution.
    const candidates =
      model && !selected && contract !== TURN_POLICY_CONTRACT
        ? eligible.filter((entry) => entry.modelFacing)
        : eligible;
    if (!candidates.length)
      return model && eligible.length
        ? {
            status: "not-model-facing",
            providers: eligible.map((entry) => entry.pluginId),
          }
        : { status: "missing" };
    if (candidates.length > 1)
      return {
        status: "ambiguous",
        providers:
          contract === TURN_POLICY_CONTRACT
            ? candidates.map((entry) => `${entry.pluginId}/${entry.name}`)
            : [...new Set(candidates.map((entry) => entry.pluginId))],
      };
    const only = candidates[0]!;
    if (!admitted.has(only.pluginId))
      return { status: "paused", pluginId: only.pluginId };
    if (model && !only.modelFacing)
      return { status: "not-model-facing", providers: [only.pluginId] };
    return only;
  }

  async resolveImport(
    caller: Pick<Caller, "sessionId" | "pluginId" | "delegation">,
    contract: string,
  ): Promise<ServiceImportResolution> {
    const selected = await this.resolveSelection(caller, contract, true);
    if ("status" in selected) return selected;
    const policy = contract === TURN_POLICY_CONTRACT;
    return {
      status: "ready",
      pluginId: selected.pluginId,
      name: selected.name,
      contract,
      access: selected.access,
      description: selected.description ?? "",
      jsonSchema: policy
        ? toolParametersJsonSchema(turnPolicyModelInputSchema)
        : selected.modelFacing!.jsonSchema,
      input: policy ? turnPolicyModelInputSchema : selected.modelFacing!.input,
    };
  }

  createClient(
    caller: Caller,
    path: readonly string[] = [],
    parentState?: CallState,
  ): PluginServiceClient {
    return this.createScopedClient(caller, path, parentState);
  }

  private createScopedClient(
    caller: Caller,
    path: readonly string[],
    parentState?: CallState,
    kernel?: KernelServiceCaller,
  ): PluginServiceClient {
    caller = {
      ...caller,
      delegation:
        caller.delegation ??
        new DelegationBudget({ sessionId: caller.sessionId }),
    };
    return {
      discover: async (contract) => {
        caller.signal.throwIfAborted();
        if (!kernel)
          await this.admission.ensure(caller.sessionId, caller.pluginId);
        const ids = new Set(await this.admission.list(caller.sessionId));
        caller.signal.throwIfAborted();
        return [...this.readEntries().values()]
          .filter(
            (entry) =>
              !entry.extension &&
              ids.has(entry.pluginId) &&
              entry.contract === contract,
          )
          .map(({ pluginId, name, contract, description }) => ({
            pluginId,
            name,
            contract,
            description,
          }))
          .sort((a, b) =>
            compareText(`${a.pluginId}/${a.name}`, `${b.pluginId}/${b.name}`),
          );
      },
      call: async (request, options) => {
        const started = performance.now();
        const state: CallState = {
          callId: crypto.randomUUID(),
          diagnosticScope: parentState?.diagnosticScope,
        };
        let errorCode: PluginServiceCallEvent["errorCode"] = "invalid-options";
        let outcome: PluginServiceCallEvent["outcome"] = "success";
        let verdict: ServiceCallOutcome["verdict"] = "clean";
        const imported =
          path.length === 0 && this.importedCalls.getStore() === true;
        let extension: PluginServiceCallEvent["extension"];
        let target = {
          providerPluginId: "<unavailable>",
          name: "<unavailable>",
          contract: "<unavailable>",
        };
        // A write call holds its provider's lock until the call ends, and
        // stages its operation only once the call has returned in time.
        let release: (() => void) | undefined;
        let staged:
          Omit<StagedOperation, "id" | "seq" | "invokedBy"> | undefined;
        try {
          const { contract } = request;
          let { pluginId, name, input } = request;
          const output = await runCall(
            caller.signal,
            options,
            async (signal) => {
              signal.throwIfAborted();
              if ((pluginId === undefined) !== (name === undefined))
                throw new ToolError(
                  "invalid-input",
                  "Specify both service pluginId and name, or neither",
                );
              if (pluginId === undefined || name === undefined) {
                errorCode = "unavailable";
                const selection = await this.resolveSelection(
                  caller,
                  contract,
                  false,
                );
                signal.throwIfAborted();
                if ("status" in selection)
                  throw new ToolError(
                    "unavailable",
                    selection.status === "ambiguous"
                      ? "More than one service provides this contract"
                      : "The selected service is unavailable",
                  );
                pluginId = selection.pluginId;
                name = selection.name;
              }
              const key = `${pluginId}/${name}`;
              // Only registered identities may enter diagnostics before host
              // admission. A malformed or unavailable request can contain
              // arbitrary plugin-controlled strings.
              const registered =
                typeof pluginId === "string" &&
                typeof name === "string" &&
                typeof contract === "string"
                  ? this.readEntries().get(key)
                  : undefined;
              if (registered?.contract === contract) {
                if (registered.extension) {
                  const { point, id, slot } = registered.extension;
                  extension = { point, id, ...(slot ? { slot } : {}) };
                }
                target = {
                  providerPluginId: registered.pluginId,
                  name: registered.name,
                  contract: registered.contract,
                };
              }
              errorCode = "cycle-or-depth-limit";
              if (path.includes(key) || path.length >= 8)
                throw new Error(
                  `Plugin service call cycle or depth limit: ${key}`,
                );
              errorCode = "admission-error";
              const diagnosticScope = kernel
                ? undefined
                : await this.admission.ensure(
                    caller.sessionId,
                    caller.pluginId,
                  );
              state.diagnosticScope =
                parentState?.diagnosticScope ??
                (typeof diagnosticScope === "string"
                  ? diagnosticScope
                  : undefined);
              signal.throwIfAborted();
              const providerScope = await this.admission.ensure(
                caller.sessionId,
                pluginId,
              );
              if (
                state.diagnosticScope === undefined &&
                typeof providerScope === "string"
              )
                state.diagnosticScope = providerScope;
              signal.throwIfAborted();
              if (typeof pluginId === "string") {
                target = { ...target, providerPluginId: pluginId };
              }
              const entry = this.readEntries().get(key);
              errorCode = "unavailable";
              if (
                !entry ||
                entry.contract !== contract ||
                (entry.extension && !kernel)
              )
                throw new Error(
                  `Plugin service unavailable: ${key} (${contract})`,
                );
              target = {
                providerPluginId: entry.pluginId,
                name: entry.name,
                contract: entry.contract,
              };
              if (contract === TURN_POLICY_CONTRACT) {
                errorCode = "invocation-error";
                try {
                  const request = turnPolicyRequestSchema.parse(input);
                  const available = caller.delegation?.remaining() ?? {
                    maxActors: 4,
                    maxSubagentCalls: 16,
                  };
                  input = turnPolicyInputSchema.parse({
                    ...request,
                    limits: {
                      maxActors: Math.min(
                        request.limits?.maxActors ?? available.maxActors,
                        available.maxActors,
                      ),
                      maxSubagentCalls: Math.min(
                        request.limits?.maxSubagentCalls ??
                          available.maxSubagentCalls,
                        available.maxSubagentCalls,
                      ),
                    },
                  });
                } catch (cause) {
                  throw new ServiceInputValidationError(cause);
                }
              }
              const stage = caller.operations;
              if (entry.access === "write") {
                if (caller.nestedIn)
                  throw new ToolError(
                    "unavailable",
                    caller.nestedIn === "write"
                      ? WRITE_SERVICE_MESSAGES.nestedWrite
                      : WRITE_SERVICE_MESSAGES.nestedInRead,
                  );
                if (!stage || kernel)
                  throw new ToolError(
                    "unavailable",
                    WRITE_SERVICE_MESSAGES.noStage,
                  );
                if (
                  entry.pluginId === caller.pluginId ||
                  entry.pluginId === stage.caller.pluginId ||
                  entry.pluginId === stage.owner.pluginId
                ) {
                  errorCode = "invocation-error";
                  throw new ToolError(
                    "refused",
                    WRITE_SERVICE_MESSAGES.selfCall,
                  );
                }
                try {
                  await stage.scope.prepareProvider(entry.pluginId);
                } catch (cause) {
                  console.warn(
                    `[plugin-services] write service ${key} is unavailable:`,
                    cause,
                  );
                  throw new ToolError(
                    "unavailable",
                    WRITE_SERVICE_MESSAGES.datasets,
                  );
                }
                signal.throwIfAborted();
                const unlock = await stage.lock(entry.pluginId);
                // The call may have ended while it waited.
                if (signal.aborted) {
                  unlock();
                  signal.throwIfAborted();
                }
                release = unlock;
              }
              extension = entry.extension
                ? {
                    point: entry.extension.point,
                    id: entry.extension.id,
                    ...(entry.extension.slot
                      ? { slot: entry.extension.slot }
                      : {}),
                  }
                : undefined;
              // Never lend the caller's store, settings, tools or proposal buffer.
              // The lent gateway strips slot secrets, and the nested client carries
              // the stripped facade so deeper hops cannot recover key material.
              const lent = caller.gateway
                ? withDefaultGatewaySignal(lendGateway(caller.gateway)!, signal)
                : undefined;
              // A kernel extension provider runs outside any runtime, so no
              // runtime traces its model calls. They are traced under the
              // provider here, failures with the tokens already spent, so
              // the cost view counts them.
              const gateway =
                lent &&
                kernel &&
                entry.extension &&
                caller.emitter &&
                caller.turnId
                  ? withGatewayTrace(lent, caller.emitter, {
                      sessionId: caller.sessionId,
                      turnId: caller.turnId,
                      pluginId: entry.pluginId,
                      runtimeId: `${entry.pluginId}/${entry.extension.id}`,
                    })
                  : lent;
              const utils = caller.utils
                ? withDefaultUtilsSignal(caller.utils, signal)
                : undefined;
              errorCode = "invocation-error";
              let providerWorld: PluginServiceContext["world"] | undefined;
              const world = () =>
                (providerWorld ??= structuredClone(
                  caller.reads?.world ?? {
                    characterSchema: null,
                    characters: [],
                    dimensions: {},
                    seats: [],
                  },
                ));
              const stagedWrites = stage
                ? () => stage.stagedWrites(entry.pluginId)
                : undefined;
              if (entry.access === "write" && stage) {
                // No model, HTTP or media access, and nested calls reach
                // read services only; the provider's own data is writable.
                const buffer = createExecutionWriteBuffer();
                const identity = {
                  sessionId: caller.sessionId,
                  turnId: stage.turnId,
                  pluginId: entry.pluginId,
                  runtimeId: `service:${entry.name}`,
                };
                const context: PluginWriteServiceContext = {
                  callerPluginId: caller.pluginId,
                  sessionId: caller.sessionId,
                  turnId: stage.turnId,
                  locale: caller.reads?.locale,
                  messages: pluginMessagesFor(
                    this.messagesOf?.(entry.pluginId),
                    caller.reads?.locale,
                  ),
                  pluginData: createServicePluginDataWriter({
                    ...(caller.reads?.store
                      ? { store: caller.reads.store }
                      : {}),
                    identity,
                    signal,
                    ...(caller.reads?.visibility
                      ? {
                          visibility: providerVisibility(
                            caller.reads.visibility,
                            entry.pluginId,
                          )!,
                        }
                      : {}),
                    staged: stagedWrites!,
                    buffer,
                  }),
                  random: createPluginRandom({
                    sessionId: caller.sessionId,
                    pluginId: entry.pluginId,
                    stream: identity.runtimeId,
                  }),
                  get world() {
                    return world();
                  },
                  getOwnSettings: () => currentOwnSettings(entry.pluginId),
                  signal,
                  services: this.createClient(
                    {
                      ...caller,
                      pluginId,
                      signal,
                      gateway: undefined,
                      utils: undefined,
                      nestedIn: "write",
                    },
                    [...path, key],
                    state,
                  ),
                };
                const result = await entry.invoke(input, context);
                if (!signal.aborted && buffer.length > 0)
                  staged = {
                    contract: entry.contract,
                    providerPluginId: entry.pluginId,
                    service: entry.name,
                    ...(caller.toolCallId !== undefined
                      ? { toolCallId: caller.toolCallId }
                      : {}),
                    // Identity is the provider's, whatever the code wrote.
                    writes: buffer.map(
                      (proposal) =>
                        ({
                          ...proposal,
                          sessionId: identity.sessionId,
                          turnId: identity.turnId,
                          source: {
                            pluginId: identity.pluginId,
                            runtimeId: identity.runtimeId,
                          },
                        }) as Proposal,
                    ),
                    request: structuredClone(input),
                    result: structuredClone(result),
                  };
                return result;
              }
              const context: PluginServiceContext = {
                random: createPluginRandom({
                  sessionId: caller.sessionId,
                  pluginId: entry.pluginId,
                  stream: `service:${entry.name}`,
                }),
                callerPluginId: caller.pluginId,
                sessionId: caller.sessionId,
                locale: caller.reads?.locale,
                messages: pluginMessagesFor(
                  this.messagesOf?.(entry.pluginId),
                  caller.reads?.locale,
                ),
                pluginData: readProviderData({
                  ...caller.reads,
                  sessionId: caller.sessionId,
                  pluginId: entry.pluginId,
                  signal,
                  ...(stagedWrites ? { staged: stagedWrites } : {}),
                }),
                get world() {
                  return world();
                },
                getOwnSettings: () => currentOwnSettings(entry.pluginId),
                signal,
                gateway,
                utils,
                services: this.createClient(
                  {
                    ...caller,
                    pluginId,
                    signal,
                    gateway,
                    utils,
                    nestedIn: caller.nestedIn ?? "read",
                  },
                  [...path, key],
                  state,
                ),
              };
              if (entry.extension && kernel)
                Object.defineProperties(
                  context,
                  Object.getOwnPropertyDescriptors(
                    kernel.extensionContext(pluginId, signal),
                  ),
                );
              const result = await entry.invoke(input, context);
              return contract === TURN_POLICY_CONTRACT
                ? caller.delegation!.clamp(
                    validateTurnPolicyOutput(
                      turnPolicyInputSchema.parse(input),
                      result,
                    ),
                    turnPolicyInputSchema.parse(input).limits,
                  )
                : result;
            },
            state,
            parentState,
          );
          if (staged) caller.operations!.record(staged);
          return output;
        } catch (error) {
          outcome = state.cancellation ?? "error";
          if (state.cancellation) errorCode = state.cancellation;
          else if (error instanceof ServiceOutputValidationError)
            errorCode = "output-validation";
          else if (error instanceof ServiceInputValidationError)
            errorCode = "input-validation";
          verdict = providerVerdict(
            errorCode,
            error,
            state.ownTimeout === true && imported,
          );
          throw tagServiceFailure(error, {
            callerPluginId: caller.pluginId,
            providerPluginId: target.providerPluginId,
            errorCode,
          });
        } finally {
          release?.();
          try {
            caller.onSettled?.({
              providerPluginId: target.providerPluginId,
              ...(caller.runtimeId !== undefined
                ? { callerRuntimeId: caller.runtimeId }
                : {}),
              verdict,
            });
          } catch {
            // Observation cannot change the service result.
          }
          const event: PluginServiceCallEvent = {
            sessionId: caller.sessionId,
            ...(state.diagnosticScope !== undefined
              ? { diagnosticScope: state.diagnosticScope }
              : {}),
            ...(caller.turnId !== undefined ? { turnId: caller.turnId } : {}),
            ...(caller.runtimeId !== undefined
              ? { runtimeId: caller.runtimeId }
              : {}),
            ...(caller.toolCallId !== undefined
              ? { toolCallId: caller.toolCallId }
              : {}),
            callId: state.callId,
            ...(parentState ? { parentCallId: parentState.callId } : {}),
            callerPluginId: caller.pluginId,
            ...target,
            ...(extension ? { extension } : {}),
            durationMs: Math.max(0, performance.now() - started),
            outcome,
            ...(outcome === "success" ? {} : { errorCode }),
          };
          try {
            const observation = this.admission.onCallCompleted?.(event);
            if (observation) void Promise.resolve(observation).catch(() => {});
          } catch {
            // Diagnostics are best effort and cannot change call results.
          }
          if (caller.emitter) {
            // The private incarnation scope never enters persisted/public trace.
            const { diagnosticScope: _scope, ...payload } = event;
            try {
              await caller.emitter.emit("plugin.service.completed", payload);
            } catch {
              console.warn("[plugin-services] trace observation failed", {
                callId: event.callId,
                sessionId: event.sessionId,
                turnId: event.turnId,
              });
            }
          }
        }
      },
    };
  }
}
