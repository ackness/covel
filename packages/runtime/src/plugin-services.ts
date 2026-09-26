import type {
  PluginServiceClient,
  PluginServiceContext,
  PluginServiceDefinition,
  PluginServiceDescriptor,
} from "@covel/shared/plugin-runtime";
import {
  withDefaultGatewaySignal,
  withDefaultUtilsSignal,
} from "./function-runtime/runtime-abort-boundaries.js";

interface Entry extends PluginServiceDescriptor {
  invoke(input: unknown, context: PluginServiceContext): Promise<unknown>;
}

interface Caller {
  readonly sessionId: string;
  readonly pluginId: string;
  readonly turnId?: string;
  readonly runtimeId?: string;
  readonly signal: AbortSignal;
  readonly gateway?: PluginServiceContext["gateway"];
  readonly utils?: PluginServiceContext["utils"];
}

export interface PluginServiceCallEvent {
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
 * `metadata` stays — it is declared plugin-facing configuration, not a
 * credential channel. Model calls still work through generateText /
 * evaluate, which never expose credentials.
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
      };
    },
  };
}

/** Scoped to one host instance; activation owns registration disposal. */
export class PluginServiceRegistry {
  private readonly entries = new Map<string, Entry>();

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
    return [...this.entries.values()]
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
    if (
      !definition ||
      typeof definition !== "object" ||
      typeof definition.name !== "string" ||
      !/^[a-zA-Z0-9][\w.-]*$/.test(definition.name) ||
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
      invoke: async (input, context) => {
        const parsed = definition.input.parse(structuredClone(input));
        context.signal.throwIfAborted();
        const result = await definition.handler(parsed, context);
        context.signal.throwIfAborted();
        return structuredClone(definition.output.parse(result));
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
    return {
      discover: async (contract) => {
        caller.signal.throwIfAborted();
        await this.admission.ensure(caller.sessionId, caller.pluginId);
        const ids = new Set(await this.admission.list(caller.sessionId));
        caller.signal.throwIfAborted();
        return [...this.entries.values()]
          .filter(
            (entry) => ids.has(entry.pluginId) && entry.contract === contract,
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
                  ? this.entries.get(key)
                  : undefined;
              if (registered?.contract === contract) {
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
              const diagnosticScope = await this.admission.ensure(
                caller.sessionId,
                caller.pluginId,
              );
              state.diagnosticScope =
                parentState?.diagnosticScope ??
                (typeof diagnosticScope === "string"
                  ? diagnosticScope
                  : undefined);
              signal.throwIfAborted();
              await this.admission.ensure(caller.sessionId, pluginId);
              signal.throwIfAborted();
              if (typeof pluginId === "string") {
                target = { ...target, providerPluginId: pluginId };
              }
              const entry = this.entries.get(key);
              errorCode = "unavailable";
              if (!entry || entry.contract !== contract)
                throw new Error(
                  `Plugin service unavailable: ${key} (${contract})`,
                );
              target = {
                providerPluginId: entry.pluginId,
                name: entry.name,
                contract: entry.contract,
              };
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
        }
      },
    };
  }
}
