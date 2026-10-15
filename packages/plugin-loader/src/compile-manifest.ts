import {
  DEFAULT_FUNCTION_HANDLER,
  DEFAULT_RUNTIME_VISIBILITY,
  defaultAgentLoop,
  defaultAgentModel,
  runtimeManifestInputSchema,
  resolveI18nText,
} from "@covel/shared";
import type {
  PluginManifest,
  RuntimeAuthoringManifest,
  RuntimeManifest,
  InputInjectDecl,
} from "@covel/shared";

function compileSource(
  source:
    { runtime: string } | { contract: string; cardinality?: "one" | "all" },
) {
  return "contract" in source
    ? {
        capability: source.contract,
        ...(source.cardinality ? { cardinality: source.cardinality } : {}),
      }
    : { runtime: source.runtime };
}
function compileDependency(
  source: NonNullable<
    NonNullable<RuntimeAuthoringManifest["schedule"]>["needs"]
  >[number],
) {
  if (typeof source === "string") return source;
  return {
    ...compileSource(source),
    ...("scope" in source && source.scope ? { scope: source.scope } : {}),
  };
}
/** Compile current authoring contracts into the kernel's execution IR. */
export function compileRuntimeManifest(
  plugin: PluginManifest,
  runtime: RuntimeAuthoringManifest,
  runtimeId: string,
): RuntimeManifest {
  const a = runtime.agent;
  // The `function` block makes a function runtime; every other one is an agent.
  const runtimeType = runtime.function ? "function" : "agent";
  // A package with one runtime has one place for its tools to go. When that
  // runtime names no plugin tools it gets the ones the package contributes;
  // `plugin: []` still means none. A runtime of a multi-runtime package
  // names its tools: each of them gets a different part.
  const contributed = plugin.contributes?.tools;
  const agentTools =
    runtimeType === "agent" &&
    runtimeId === plugin.id &&
    !a?.tools?.plugin &&
    contributed?.length
      ? { ...a?.tools, plugin: [...contributed] }
      : a?.tools;
  const loop = a?.loop;
  const visibility = runtime.io?.visibility ?? DEFAULT_RUNTIME_VISIBILITY;
  // An agent that leaves out its slot or loop limits gets the defaults of its
  // visibility; a function runtime has no loop and names a slot only when
  // its handler calls a model.
  const loopDefaults =
    runtimeType === "agent" ? defaultAgentLoop(visibility) : undefined;
  const schedule = runtime.schedule;
  // `auto` is the default trigger and `every` its cadence.
  const trigger =
    schedule?.trigger || schedule?.every !== undefined
      ? {
          ...schedule?.trigger,
          type: schedule?.trigger?.type ?? ("auto" as const),
          ...(schedule?.every !== undefined ? { every: schedule.every } : {}),
        }
      : undefined;
  const inject: InputInjectDecl[] = (runtime.io?.selfData ?? []).map(
    (entry) => ({ kind: "plugin-data", ...entry }),
  );
  const inputs: Record<string, unknown> = {};
  for (const [name, binding] of Object.entries(runtime.io?.inputs ?? {})) {
    if ("kernel" in binding.from)
      inject.push({ kind: "kernel", from: binding.from.kernel, name });
    else if (binding.scope === "committed")
      inject.push({
        kind: "runtime-export",
        name,
        from: compileSource(binding.from),
        recordAs: binding.recordAs!,
        ...(binding.accepts ? { accepts: binding.accepts } : {}),
        ...(binding.required === undefined
          ? {}
          : { required: binding.required }),
      });
    else {
      const { scope: _scope, recordAs: _recordAs, ...rest } = binding;
      inputs[name] = { ...rest, from: compileSource(binding.from) };
    }
  }
  const contract = runtime.io?.output?.contract;
  const output = runtime.io?.output;
  const parsed = runtimeManifestInputSchema.parse({
    name: runtimeId,
    version: plugin.version,
    description: runtime.description ?? plugin.description,
    pluginType: plugin.kind === "core" ? "core-plugin" : "plugin",
    runtimeType,
    // The loader leaves the runtime out when the default file is missing.
    handler: runtime.function
      ? (runtime.function.handler ?? DEFAULT_FUNCTION_HANDLER)
      : undefined,
    guard: runtime.guard,
    model:
      runtimeType === "agent"
        ? (a?.model ?? defaultAgentModel(visibility))
        : runtime.function?.model,
    llm: a?.llm,
    history: a?.history,
    tools: runtime.function?.tools ?? agentTools,
    advertiseEvents: a?.advertiseEvents,
    stage: schedule?.stage,
    trigger,
    needs: schedule?.needs?.map(compileDependency),
    after: schedule?.after?.map(compileDependency),
    turnCompletion: schedule?.completion,
    execution: schedule?.manual?.execution,
    effects: runtime.effects,
    permissions: runtime.permissions,
    maxSteps: loop?.maxSteps,
    timeoutMs:
      runtime.function?.timeoutMs ?? loop?.timeoutMs ?? loopDefaults?.timeoutMs,
    callTimeoutMs: loop?.callTimeoutMs ?? loopDefaults?.callTimeoutMs,
    firstTokenTimeoutMs: loop?.firstTokenTimeoutMs,
    idleTimeoutMs: loop?.idleTimeoutMs,
    maxRetries: loop?.maxRetries ?? loopDefaults?.maxRetries,
    loopDetectionThreshold: loop?.loopDetection,
    maxRecursionDepth: loop?.maxRecursionDepth,
    requireToolUse: loop?.completion?.require === "tool-use" || undefined,
    requireExplicitCompletion:
      loop?.completion?.require === "explicit" || undefined,
    completeAfterTools: loop?.completion?.afterTools,
    outputKind: visibility,
    ...(runtime.io?.concealed ? { concealed: true } : {}),
    ...(output
      ? { output: { schema: output.schema, recordAs: output.recordAs } }
      : {}),
    ...(Object.keys(inputs).length ? { inputs } : {}),
    ...(inject.length || runtime.io?.payloadSchema
      ? { input: { inject, schema: runtime.io?.payloadSchema } }
      : {}),
    outputContract: contract,
    defaultProvider:
      contract &&
      plugin.provides?.some(
        (p) => typeof p !== "string" && p.contract === contract && p.default,
      )
        ? true
        : undefined,
  });
  return {
    ...parsed,
    description: resolveI18nText(parsed.description, "en") ?? "",
    pluginId: plugin.id,
  };
}
