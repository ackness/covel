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
  readonly signal: AbortSignal;
  readonly gateway?: PluginServiceContext["gateway"];
  readonly utils?: PluginServiceContext["utils"];
}

async function runCall(
  parentSignal: AbortSignal,
  options: Parameters<PluginServiceClient["call"]>[1],
  invoke: (signal: AbortSignal) => Promise<unknown>,
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
      const relay = () => controller.abort(signal.reason);
      if (signal.aborted) relay();
      else {
        signal.addEventListener("abort", relay, { once: true });
        cleanups.push(() => signal.removeEventListener("abort", relay));
      }
    }
    controller.signal.throwIfAborted();
    if (timeoutMs !== undefined)
      timer = setTimeout(
        () =>
          controller.abort(
            new DOMException("Plugin service call timed out", "TimeoutError"),
          ),
        timeoutMs,
      );
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
      ensure(sessionId: string, pluginId: string): Promise<void>;
    },
  ) {}

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
      call: async (request, options) =>
        runCall(caller.signal, options, async (signal) => {
          signal.throwIfAborted();
          const { pluginId, name, contract, input } = request;
          const key = `${pluginId}/${name}`;
          if (path.includes(key) || path.length >= 8)
            throw new Error(`Plugin service call cycle or depth limit: ${key}`);
          await this.admission.ensure(caller.sessionId, caller.pluginId);
          signal.throwIfAborted();
          await this.admission.ensure(caller.sessionId, pluginId);
          signal.throwIfAborted();
          const entry = this.entries.get(key);
          if (!entry || entry.contract !== contract)
            throw new Error(`Plugin service unavailable: ${key} (${contract})`);
          // Never lend the caller's store, settings, tools or proposal buffer.
          // The lent gateway strips slot secrets, and the nested client carries
          // the stripped facade so deeper hops cannot recover key material.
          const gateway = caller.gateway
            ? withDefaultGatewaySignal(lendGateway(caller.gateway)!, signal)
            : undefined;
          const utils = caller.utils
            ? withDefaultUtilsSignal(caller.utils, signal)
            : undefined;
          return entry.invoke(input, {
            callerPluginId: caller.pluginId,
            signal,
            gateway,
            utils,
            services: this.createClient(
              { ...caller, pluginId, signal, gateway, utils },
              [...path, key],
            ),
          });
        }),
    };
  }
}
