import {
  createRootOperationStage,
  PluginServiceRegistry,
} from "@covel/runtime";
import type { OperationRecord, Proposal, RuntimeResult } from "@covel/shared";
import type {
  PluginServiceContext,
  PluginServiceDefinition,
  PluginWriteServiceContext,
} from "@covel/shared/plugin-runtime";
import type { DataStore } from "@covel/store";

/** A service definition of any input and output type. */
export interface TestServiceDefinition {
  readonly name: string;
  readonly contract: string;
  readonly description?: string;
  readonly modelFacing?: boolean;
  /** `write` for a service that changes its plugin's data; `read` by default. */
  readonly access?: "read" | "write";
  readonly inputSchema?: Readonly<Record<string, unknown>>;
  readonly input: { parse(value: unknown): unknown };
  readonly output: { parse(value: unknown): unknown };
  // Method syntax: a handler typed for its own input and either context fits
  // here. A write service receives the write context at call time.
  handler(
    input: never,
    context: PluginServiceContext & PluginWriteServiceContext,
  ): unknown;
}

/**
 * A real service registry for tool tests, in which every listed plugin is
 * active and approved. Pass it as `services` in the context given to
 * `executeToolAndCommit`, and the tool gets `context.services`.
 */
export function makeTestServiceRegistry(options: {
  /** Only this session's calls are admitted, when given. */
  readonly sessionId?: string;
  /** Plugins that may call services; every provider below is added. */
  readonly activePluginIds?: readonly string[];
  /** Services to register, keyed by the providing plugin's ID. */
  readonly services?: Readonly<
    Record<string, readonly TestServiceDefinition[]>
  >;
  /** Plugins paused after repeated errors: imports count them, calls fail. */
  readonly pausedPluginIds?: readonly string[];
}): PluginServiceRegistry {
  const paused = new Set(options.pausedPluginIds ?? []);
  const active = new Set([
    ...(options.activePluginIds ?? []),
    ...Object.keys(options.services ?? {}),
  ]);
  const inSession = (sessionId: string) =>
    options.sessionId === undefined || options.sessionId === sessionId;
  const admitted = (sessionId: string) =>
    inSession(sessionId) ? [...active].filter((id) => !paused.has(id)) : [];
  const registry = new PluginServiceRegistry({
    list: async (sessionId) => admitted(sessionId),
    ensure: async (sessionId, pluginId) => {
      if (!admitted(sessionId).includes(pluginId))
        throw new Error(`Plugin is not active: ${pluginId}`);
    },
    paused: async (sessionId) =>
      inSession(sessionId) ? [...paused].filter((id) => active.has(id)) : [],
  });
  for (const [pluginId, definitions] of Object.entries(options.services ?? {}))
    for (const definition of definitions)
      registry.register(
        pluginId,
        definition as unknown as PluginServiceDefinition<unknown, unknown>,
      );
  return registry;
}

/** One operation a write-service call staged: its record and its writes. */
export interface TestServiceOperation {
  readonly record: OperationRecord;
  /** The provider's writes, carrying the provider's identity. */
  readonly writes: readonly Proposal[];
}

/**
 * Call a service the way a runtime of `caller.pluginId` would, without a
 * turn. A write service stages into a fresh stage; the result lists what it
 * staged (nothing commits). `store` holds the provider's committed data.
 */
export async function callTestService(options: {
  readonly registry: PluginServiceRegistry;
  readonly caller: {
    readonly pluginId: string;
    readonly runtimeId?: string;
    readonly sessionId?: string;
    readonly turnId?: string;
    readonly locale?: string;
  };
  readonly request: {
    readonly pluginId: string;
    readonly name: string;
    readonly contract: string;
    readonly input: unknown;
  };
  readonly store?: Pick<DataStore, "getPluginData" | "listPluginData">;
  readonly signal?: AbortSignal;
}): Promise<{
  readonly output: unknown;
  readonly operations: readonly TestServiceOperation[];
}> {
  const { caller } = options;
  const sessionId = caller.sessionId ?? "test-session";
  const turnId = caller.turnId ?? "test-turn";
  const runtimeId = caller.runtimeId ?? `${caller.pluginId}/test`;
  const stage = createRootOperationStage({
    caller: { pluginId: caller.pluginId, runtimeId },
    sessionId,
    turnId,
  });
  const client = options.registry.createClient({
    sessionId,
    turnId,
    pluginId: caller.pluginId,
    runtimeId,
    signal: options.signal ?? new AbortController().signal,
    reads: {
      ...(caller.locale !== undefined ? { locale: caller.locale } : {}),
      ...(options.store ? { store: options.store } : {}),
    },
    operations: stage,
  });
  const output = await client.call(options.request);
  const carrier: Pick<RuntimeResult, "operations" | "operationWrites"> = {};
  stage.attachTo(carrier as RuntimeResult, true);
  return {
    output,
    operations: (carrier.operations ?? []).map((record) => ({
      record,
      writes: carrier.operationWrites?.[record.id] ?? [],
    })),
  };
}
