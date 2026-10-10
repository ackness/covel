import {
  promptHistoryTransformV1,
  promptSegmentV1,
  sessionWorldContextV1,
  uiSlotV1,
  mediaImageFlowV1,
  historyCompactV2,
  type ExtensionDeclaration,
  type ExtensionMode,
  type ExtensionPluginDataRecord,
  type ExtensionPoint,
  type ExtensionResult,
  type PluginExtensionDefinition,
  type PluginMessageCatalog,
  isHiddenPluginDataNamespace,
  pluginMessagesFor,
} from "@covel/shared";
import type { PluginServiceContext } from "@covel/shared/plugin-runtime";
import { PluginServiceRegistry } from "./plugin-services.js";

export interface PluginExtensionExecutionScope {
  readonly emitter?: import("./trace/turn-emitter.js").TurnEmitter;
  readonly world?: import("@covel/shared").WorldModelView;
  readonly sessionId: string;
  readonly locale: string;
  readonly turnId?: string;
  readonly runtimeIdentities?: readonly {
    readonly name: string;
    readonly pluginId: string;
  }[];
  readonly signal: AbortSignal;
  readonly gateway?: PluginServiceContext["gateway"];
  readonly utils?: PluginServiceContext["utils"];
  /**
   * Reads one namespace of one provider's data. The host calls it on first
   * access, at most once per plugin and namespace in an execution, and hands
   * providers detached copies of that read for the rest of the execution.
   */
  readonly readPluginData: (
    pluginId: string,
    namespace: string,
  ) => Promise<readonly ExtensionPluginDataRecord[]>;
}

export interface PluginExtensionExecution {
  run<I, O, M extends ExtensionMode>(
    point: ExtensionPoint<I, O, M>,
    input: I,
  ): Promise<ExtensionResult<O, M>>;
}

/** Kernel definitions only. Provider handlers live in PluginServiceRegistry. */
export const kernelExtensionPoints: readonly ExtensionPoint<
  unknown,
  unknown
>[] = [
  promptHistoryTransformV1,
  promptSegmentV1,
  sessionWorldContextV1,
  uiSlotV1,
  historyCompactV2,
  mediaImageFlowV1,
];

// Cache JSON-like values structurally; unsupported objects simply do not cache.
// Tagged primitives distinguish undefined, null, array holes and object keys.
function cacheKey(value: unknown): string | undefined {
  const seen = new Set<object>();
  const encode = (item: unknown): unknown => {
    if (item === null) return ["null"];
    if (item === undefined) return ["undefined"];
    if (typeof item === "string" || typeof item === "boolean")
      return [typeof item, item];
    if (typeof item === "number" && Number.isFinite(item))
      return ["number", Object.is(item, -0) ? "-0" : item];
    if (typeof item !== "object") throw new Error("Not a cacheable value");
    if (seen.has(item)) throw new Error("Cyclic input");
    seen.add(item);
    try {
      if (Array.isArray(item))
        return [
          "array",
          Array.from({ length: item.length }, (_, index) =>
            index in item ? encode(item[index]) : ["hole"],
          ),
        ];
      if (
        Object.getPrototypeOf(item) !== Object.prototype &&
        Object.getPrototypeOf(item) !== null
      )
        throw new Error("Not a plain object");
      return [
        "object",
        Object.keys(item)
          .sort()
          .map((key) => [key, encode((item as Record<string, unknown>)[key])]),
      ];
    } finally {
      seen.delete(item);
    }
  };
  try {
    return JSON.stringify(encode(value));
  } catch {
    return undefined;
  }
}

function nextPipelineInput<I, O>(
  point: ExtensionPoint<I, O>,
  previous: I,
  output: O,
): I {
  if (point.nextInput)
    return point.input.parse(point.nextInput(previous, output));
  if (
    previous &&
    output &&
    typeof previous === "object" &&
    typeof output === "object" &&
    !Array.isArray(previous) &&
    !Array.isArray(output)
  )
    return point.input.parse({ ...previous, ...output });
  return point.input.parse(output);
}

async function waitForExecution(
  result: Promise<unknown>,
  signal: AbortSignal,
): Promise<unknown> {
  signal.throwIfAborted();
  let onAbort: () => void = () => {};
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    return await Promise.race([result, aborted]);
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}

export class PluginExtensionHost {
  private readonly points: ReadonlyMap<
    string,
    ExtensionPoint<unknown, unknown>
  >;

  constructor(
    private readonly services: PluginServiceRegistry,
    points: readonly ExtensionPoint<unknown, unknown>[] = kernelExtensionPoints,
    /** A plugin's `messages` translations, for the provider's `ctx.messages`. */
    private readonly messagesOf?: (
      pluginId: string,
    ) => readonly PluginMessageCatalog[] | undefined,
  ) {
    this.points = new Map(points.map((point) => [point.id, point]));
    if (this.points.size !== points.length)
      throw new Error("Duplicate kernel extension point");
  }

  register<I, O>(
    pluginId: string,
    declaration: ExtensionDeclaration,
    definition: PluginExtensionDefinition<I, O>,
  ): () => void {
    const point = this.points.get(declaration.point);
    if (!point)
      throw new Error(`Unknown kernel extension point: ${declaration.point}`);
    if (typeof definition?.handler !== "function")
      throw new TypeError("Extension requires a handler");
    if (declaration.order !== undefined && !Number.isFinite(declaration.order))
      throw new TypeError("Extension order must be finite");
    return this.services.registerExtension(
      pluginId,
      point as ExtensionPoint<I, O>,
      declaration,
      definition,
    );
  }

  list() {
    return this.services.listExtensions();
  }

  createExecution(
    scope: PluginExtensionExecutionScope,
  ): PluginExtensionExecution {
    const world = structuredClone(
      scope.world ?? { characterSchema: null, characters: [], dimensions: {} },
    );
    const reads = new Map<
      string,
      Promise<readonly ExtensionPluginDataRecord[]>
    >();
    // Providers only ever see their own namespaces, so the host never loads
    // the whole session. Filtering keeps isolation independent of the reader.
    const namespaceRows = (pluginId: string, namespace: string) => {
      // Extension output reaches prompts or clients, so hidden world data is
      // never readable here — only the owning plugin's runtimes see it.
      if (isHiddenPluginDataNamespace(namespace))
        return Promise.resolve([] as readonly ExtensionPluginDataRecord[]);
      const key = JSON.stringify([pluginId, namespace]);
      let rows = reads.get(key);
      if (!rows) {
        rows = scope
          .readPluginData(pluginId, namespace)
          .then((loaded) =>
            structuredClone(loaded).filter(
              (row) =>
                row.pluginId === pluginId &&
                row.namespace === namespace &&
                (row.sessionId === undefined ||
                  row.sessionId === scope.sessionId),
            ),
          );
        reads.set(key, rows);
        rows.catch(() => {
          if (reads.get(key) === rows) reads.delete(key);
        });
      }
      return rows;
    };
    const cache = new Map<string, Promise<unknown>>();
    const client = this.services.createKernelClient({
      ...scope,
      extensionContext: (pluginId, signal) => ({
        world: structuredClone(world),
        sessionId: scope.sessionId,
        locale: scope.locale,
        messages: pluginMessagesFor(this.messagesOf?.(pluginId), scope.locale),
        turnId: scope.turnId,
        pluginData: {
          get: async (namespace, key) => {
            signal.throwIfAborted();
            const rows = await namespaceRows(pluginId, namespace);
            signal.throwIfAborted();
            return structuredClone(rows.find((row) => row.key === key));
          },
          list: async (namespace) => {
            signal.throwIfAborted();
            const rows = await namespaceRows(pluginId, namespace);
            signal.throwIfAborted();
            return structuredClone(rows);
          },
        },
      }),
    });
    return {
      run: async <I, O, M extends ExtensionMode>(
        point: ExtensionPoint<I, O, M>,
        input: I,
      ): Promise<ExtensionResult<O, M>> => {
        scope.signal.throwIfAborted();
        if (this.points.get(point.id) !== point)
          throw new Error(`Unregistered kernel extension point: ${point.id}`);
        const parsed = point.input.parse(structuredClone(input));
        const key = point.mode === "single" ? undefined : cacheKey(parsed);
        const fullKey = key === undefined ? undefined : `${point.id}\n${key}`;
        let result = fullKey === undefined ? undefined : cache.get(fullKey);
        if (!result) {
          result = (async () => {
            const providers = [
              ...(await this.services.discoverExtensions(
                scope.sessionId,
                point.id,
              )),
            ]
              .filter(
                (provider) => point.matchesProvider?.(parsed, provider) ?? true,
              )
              .sort(
                (a, b) =>
                  (a.order ?? 0) - (b.order ?? 0) ||
                  (a.pluginId < b.pluginId
                    ? -1
                    : a.pluginId > b.pluginId
                      ? 1
                      : 0) ||
                  (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
              );
            scope.signal.throwIfAborted();
            if (point.mode === "single" && providers.length > 1)
              throw new Error(
                `Conflicting providers for single extension point: ${point.id}`,
              );
            const collected: O[] = [];
            let current = parsed;
            let output: O | undefined;
            for (const provider of providers) {
              scope.signal.throwIfAborted();
              let value: O;
              try {
                value = (await client.call(
                  {
                    pluginId: provider.pluginId,
                    name: provider.name,
                    contract: point.id,
                    input: point.mode === "pipeline" ? current : parsed,
                  },
                  { timeoutMs: point.timeoutMs },
                )) as O;
              } catch (error) {
                scope.signal.throwIfAborted();
                if (point.onError === "fail-turn") throw error;
                // The service diagnostic is sanitized and carries no reason, so
                // the server log is where an author finds why a provider's
                // contribution is missing.
                console.warn(
                  `[plugin-extensions] skipped provider ${provider.pluginId}/${provider.id} of ${point.id} for session ${scope.sessionId}: ` +
                    (error instanceof Error ? error.message : String(error)),
                );
                continue;
              }
              // Composition belongs to the kernel contract. A broken contract
              // fails immediately rather than silently blaming a provider.
              const next =
                point.mode === "pipeline"
                  ? nextPipelineInput(point, current, value)
                  : current;
              output = value;
              current = next;
              collected.push(value);
            }
            if (point.mode === "collect") return collected;
            if (point.mode === "single") {
              if (
                point.id === sessionWorldContextV1.id &&
                typeof output === "object" &&
                output !== null
              ) {
                const supplied = output as {
                  dimensionRecovery?: {
                    editorRuntimeId: string;
                    trackerRuntimeId: string;
                  };
                };
                if (supplied.dimensionRecovery) {
                  for (const name of Object.values(
                    supplied.dimensionRecovery,
                  )) {
                    if (
                      !scope.runtimeIdentities?.some(
                        (runtime) =>
                          runtime.name === name &&
                          runtime.pluginId === providers[0]!.pluginId,
                      )
                    )
                      throw new Error(
                        "Dimension recovery runtime is not owned by the active provider",
                      );
                  }
                }
                return {
                  ...output,
                  dimensionProviderPluginId: providers[0]!.pluginId,
                };
              }
              return output;
            }
            return (
              output ??
              point.output.parse(
                point.initialOutput ? point.initialOutput(parsed) : current,
              )
            );
          })();
          if (fullKey !== undefined) cache.set(fullKey, result);
        }
        const value = await waitForExecution(result, scope.signal);
        scope.signal.throwIfAborted();
        return structuredClone(value) as ExtensionResult<O, M>;
      },
    };
  }
}
