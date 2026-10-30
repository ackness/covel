import { PluginServiceRegistry } from "@covel/runtime";
import type {
  PluginServiceContext,
  PluginServiceDefinition,
} from "@covel/shared/plugin-runtime";

/** A service definition of any input and output type. */
export interface TestServiceDefinition {
  readonly name: string;
  readonly contract: string;
  readonly description?: string;
  readonly modelFacing?: boolean;
  readonly inputSchema?: Readonly<Record<string, unknown>>;
  readonly input: { parse(value: unknown): unknown };
  readonly output: { parse(value: unknown): unknown };
  // Method syntax: a handler typed for its own input fits here.
  handler(input: never, context: PluginServiceContext): unknown;
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
