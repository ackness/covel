import type {
  PluginServiceClient,
  PluginServiceContext,
  PluginServiceDefinition,
  PluginServiceDescriptor,
} from "@covel/shared/plugin-runtime";

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
      !/^[a-zA-Z0-9][\w.-]*$/.test(definition.name) ||
      !definition.contract.trim()
    ) {
      throw new Error("Service requires a valid name and a versioned contract");
    }
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
      call: async (request) => {
        caller.signal.throwIfAborted();
        const { pluginId, name, contract, input } = request;
        const key = `${pluginId}/${name}`;
        if (path.includes(key) || path.length >= 8)
          throw new Error(`Plugin service call cycle or depth limit: ${key}`);
        await this.admission.ensure(caller.sessionId, caller.pluginId);
        await this.admission.ensure(caller.sessionId, pluginId);
        caller.signal.throwIfAborted();
        const entry = this.entries.get(key);
        if (!entry || entry.contract !== contract)
          throw new Error(`Plugin service unavailable: ${key} (${contract})`);
        // Never lend the caller's store, settings, tools or proposal buffer.
        // The lent gateway strips slot secrets, and the nested client carries
        // the stripped facade so deeper hops cannot recover key material.
        const gateway = lendGateway(caller.gateway);
        return entry.invoke(input, {
          callerPluginId: caller.pluginId,
          signal: caller.signal,
          gateway,
          utils: caller.utils,
          services: this.createClient({ ...caller, pluginId, gateway }, [
            ...path,
            key,
          ]),
        });
      },
    };
  }
}
