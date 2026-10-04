import { runtimeManifestInputSchema, resolveI18nText } from "@covel/shared";
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
  // A package with one runtime has one place for its tools to go. When that
  // runtime names no plugin tools it gets the ones the package contributes;
  // `plugin: []` still means none. A runtime of a multi-runtime package
  // names its tools: each of them gets a different part.
  const contributed = plugin.contributes?.tools;
  const agentTools =
    runtime.type === "agent" &&
    runtimeId === plugin.id &&
    !a?.tools?.plugin &&
    contributed?.length
      ? { ...a?.tools, plugin: [...contributed] }
      : a?.tools;
  const loop = a?.loop;
  const schedule = runtime.schedule;
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
    runtimeType: runtime.type,
    handler: runtime.function?.handler,
    guard: runtime.guard,
    model: a?.model ?? runtime.function?.model,
    llm: a?.llm,
    history: a?.history,
    tools: runtime.function?.tools ?? agentTools,
    advertiseEvents: a?.advertiseEvents,
    stage: schedule?.stage,
    trigger: schedule?.trigger,
    needs: schedule?.needs?.map(compileDependency),
    after: schedule?.after?.map(compileDependency),
    turnCompletion: schedule?.completion,
    execution: schedule?.manual?.execution,
    effects: runtime.effects,
    permissions: runtime.permissions,
    maxSteps: loop?.maxSteps,
    timeoutMs: runtime.function?.timeoutMs ?? loop?.timeoutMs,
    callTimeoutMs: loop?.callTimeoutMs,
    firstTokenTimeoutMs: loop?.firstTokenTimeoutMs,
    idleTimeoutMs: loop?.idleTimeoutMs,
    maxRetries: loop?.maxRetries,
    loopDetectionThreshold: loop?.loopDetection,
    maxRecursionDepth: loop?.maxRecursionDepth,
    requireToolUse: loop?.completion?.require === "tool-use" || undefined,
    requireExplicitCompletion:
      loop?.completion?.require === "explicit" || undefined,
    completeAfterTools: loop?.completion?.afterTools,
    outputKind: runtime.io?.visibility,
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
