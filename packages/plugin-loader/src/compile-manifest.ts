import {
  DEFAULT_FUNCTION_HANDLER,
  DEFAULT_RUNTIME_VISIBILITY,
  defaultAgentLoop,
  defaultAgentModel,
  runtimeManifestInputSchema,
  resolveI18nText,
  serviceImportName,
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

type AuthoredAgent = NonNullable<RuntimeAuthoringManifest["agent"]>;

/**
 * The completion rule an agent writes: `finishWith: <tool>` is the short form
 * of `completion: { require: tool-use, afterTools: [<tool>] }`.
 */
function agentCompletion(agent: AuthoredAgent | undefined) {
  if (agent?.finishWith === undefined) return agent?.completion;
  return { require: "tool-use" as const, afterTools: [agent.finishWith] };
}

/**
 * The model call options of an agent. `finishWith` makes the model call a
 * tool on every step unless the agent names its own `toolChoice`.
 */
function agentLlm(agent: AuthoredAgent | undefined) {
  const toolChoice =
    agent?.toolChoice ??
    (agent?.finishWith !== undefined ? ("required" as const) : undefined);
  const llm = {
    ...(agent?.reasoning === false
      ? { reasoningEffort: "disabled" as const }
      : {}),
    ...(toolChoice ? { toolChoice } : {}),
  };
  return Object.keys(llm).length ? llm : undefined;
}

/**
 * The loop profile keys the author wrote under `agent.loop`, renamed for the
 * IR (`profile` → `preset`). Nothing is filled in: the agent loop resolves
 * the profile when it runs. Undefined when the author wrote none.
 */
function agentLoopProfile(agent: AuthoredAgent | undefined) {
  const loop = agent?.loop;
  const finalizer = loop?.finalizer && {
    ...(loop.finalizer.maxSteps !== undefined
      ? { maxSteps: loop.finalizer.maxSteps }
      : {}),
    ...(loop.finalizer.deadlineReserveMs !== undefined
      ? { deadlineReserveMs: loop.finalizer.deadlineReserveMs }
      : {}),
  };
  const corrections =
    loop?.corrections &&
    Object.fromEntries(
      Object.entries(loop.corrections).filter(
        ([, value]) => value !== undefined,
      ),
    );
  const profile = {
    ...(loop?.profile ? { preset: loop.profile } : {}),
    ...(loop?.stream !== undefined ? { stream: loop.stream } : {}),
    ...(loop?.steering !== undefined ? { steering: loop.steering } : {}),
    ...(loop?.truncation ? { truncation: loop.truncation } : {}),
    ...(loop?.fallback ? { fallback: loop.fallback } : {}),
    ...(finalizer && Object.keys(finalizer).length ? { finalizer } : {}),
    ...(corrections && Object.keys(corrections).length ? { corrections } : {}),
  };
  return Object.keys(profile).length ? profile : undefined;
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
  const { services: imports, ...authoredTools } = a?.tools ?? {};
  const contributedTools =
    runtimeType === "agent" &&
    runtimeId === plugin.id &&
    !authoredTools.plugin &&
    contributed?.length
      ? { plugin: [...contributed] }
      : undefined;
  const agentTools =
    a?.tools || contributedTools
      ? {
          ...authoredTools,
          ...contributedTools,
          // One place derives an import's tool name; the rules and the
          // kernel read the compiled value.
          ...(imports
            ? {
                services: imports.map((entry) => ({
                  contract: typeof entry === "string" ? entry : entry.contract,
                  name: serviceImportName(entry),
                })),
              }
            : {}),
        }
      : undefined;
  const loop = a?.loop;
  const loopProfile = agentLoopProfile(a);
  const completion = agentCompletion(a);
  const visibility = runtime.io?.visibility ?? DEFAULT_RUNTIME_VISIBILITY;
  // An agent that leaves out its slot or loop limits gets the defaults of its
  // visibility; a function runtime has no loop and names a slot only when
  // its handler calls a model.
  const loopDefaults =
    runtimeType === "agent" ? defaultAgentLoop(visibility) : undefined;
  const schedule = runtime.schedule;
  const detached = schedule?.detached;
  // `auto` is the default trigger and `every` its cadence. A sub-agent-only
  // runtime is activated by its caller, so its trigger is `manual`.
  const subagentOnly = schedule?.subagentOnly === true;
  const trigger =
    schedule?.trigger || schedule?.every !== undefined || subagentOnly
      ? {
          ...schedule?.trigger,
          type:
            schedule?.trigger?.type ??
            (subagentOnly ? ("manual" as const) : ("auto" as const)),
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
    llm: agentLlm(a),
    history: a?.history,
    tools: runtime.function?.tools ?? agentTools,
    advertiseEvents: a?.advertiseEvents,
    stage: schedule?.stage,
    trigger,
    ...(subagentOnly ? { subagentOnly: true as const } : {}),
    needs: schedule?.needs?.map(compileDependency),
    after: schedule?.after?.map(compileDependency),
    turnCompletion: detached
      ? { mode: "detached", ...(detached === true ? {} : detached) }
      : undefined,
    execution: schedule?.background ? "background" : undefined,
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
    requireToolUse: completion?.require === "tool-use" || undefined,
    requireExplicitCompletion: completion?.require === "explicit" || undefined,
    completeAfterTools: completion?.afterTools,
    ...(loopProfile ? { loopProfile } : {}),
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
