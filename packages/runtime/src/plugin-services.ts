import { AsyncLocalStorage } from "node:async_hooks";
import type {
  PluginServiceClient,
  PluginServiceContext,
  PluginServiceDefinition,
  PluginServiceDescriptor,
} from "@covel/shared/plugin-runtime";
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

class ServiceOutputValidationError extends Error {
  constructor() {
    super("Plugin service output failed validation");
  }
}

interface Entry extends PluginServiceDescriptor {
  readonly extension?: ExtensionDeclaration;
  invoke(input: unknown, context: PluginServiceContext): Promise<unknown>;
}

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

interface Caller {
  /** Host-owned trace destination; never exposed in the plugin context. */
  readonly emitter?: TurnEmitter;
  readonly sessionId: string;
  readonly pluginId: string;
  readonly turnId?: string;
  readonly runtimeId?: string;
  readonly signal: AbortSignal;
  readonly gateway?: PluginServiceContext["gateway"];
  readonly utils?: PluginServiceContext["utils"];
}

export interface PluginServiceCallEvent {
  readonly extension?: Pick<ExtensionDeclaration, "point" | "id" | "slot">;
  readonly sessionId: string;
  /** Opaque host admission scope; inherited by nested calls once known. */
  readonly diagnosticScope?: string;
  readonly turnId?: string;
  readonly runtimeId?: string;
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
    | "invocation-error"
    | "output-validation"
    | "timeout"
    | "cancelled";
}

interface CallState {
  readonly callId: string;
  diagnosticScope?: string;
  cancellation?: "timeout" | "cancelled";
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

/** Scoped to one host instance; activation owns registration disposal. */
export class PluginServiceRegistry {
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
      /** Host-owned observer; failures must never affect service execution. */
      onCallCompleted?(event: PluginServiceCallEvent): void | Promise<void>;
    },
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
        `${a.pluginId}/${a.name}`.localeCompare(`${b.pluginId}/${b.name}`),
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
        typeof definition.description !== "string")
    )
      throw new TypeError(
        "Service requires input/output parsers, a handler, and an optional string description",
      );
    const key = `${pluginId}/${definition.name}`;
    if (this.entries.has(key))
      throw new Error(`Duplicate plugin service: ${key}`);
    const entry: Entry = {
      pluginId,
      name: definition.name,
      contract: definition.contract,
      description: definition.description,
      extension,
      invoke: async (input, context) => {
        const parsed = definition.input.parse(structuredClone(input));
        context.signal.throwIfAborted();
        const result = await definition.handler(parsed, context);
        context.signal.throwIfAborted();
        try {
          return structuredClone(definition.output.parse(result));
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
            `${a.pluginId}/${a.name}`.localeCompare(`${b.pluginId}/${b.name}`),
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
        let extension: PluginServiceCallEvent["extension"];
        let target = {
          providerPluginId: "<unavailable>",
          name: "<unavailable>",
          contract: "<unavailable>",
        };
        try {
          const { pluginId, name, contract, input } = request;
          return await runCall(
            caller.signal,
            options,
            async (signal) => {
              signal.throwIfAborted();
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
              const gateway = caller.gateway
                ? withDefaultGatewaySignal(lendGateway(caller.gateway)!, signal)
                : undefined;
              const utils = caller.utils
                ? withDefaultUtilsSignal(caller.utils, signal)
                : undefined;
              errorCode = "invocation-error";
              return entry.invoke(input, {
                ...(entry.extension && kernel
                  ? kernel.extensionContext(pluginId, signal)
                  : {}),
                callerPluginId: caller.pluginId,
                signal,
                gateway,
                utils,
                services: this.createClient(
                  { ...caller, pluginId, signal, gateway, utils },
                  [...path, key],
                  state,
                ),
              });
            },
            state,
            parentState,
          );
        } catch (error) {
          outcome = state.cancellation ?? "error";
          if (state.cancellation) errorCode = state.cancellation;
          else if (error instanceof ServiceOutputValidationError)
            errorCode = "output-validation";
          throw error;
        } finally {
          const event: PluginServiceCallEvent = {
            sessionId: caller.sessionId,
            ...(state.diagnosticScope !== undefined
              ? { diagnosticScope: state.diagnosticScope }
              : {}),
            ...(caller.turnId !== undefined ? { turnId: caller.turnId } : {}),
            ...(caller.runtimeId !== undefined
              ? { runtimeId: caller.runtimeId }
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
