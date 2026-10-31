/**
 * The tools the kernel generates for one agent run, beside the ones it
 * declares: today, imported services (`agent.tools.services`).
 *
 * Each agent entry (a top-level run, a resumed run, a sub-agent) resolves
 * them at start and wraps its raw tool executor, so the loop advertises,
 * searches and executes them like any other tool without knowing they are
 * generated. A generated tool that did not resolve is absent: not
 * advertised, and a call to it answers `unavailable`.
 */

import type { RuntimeManifest, TurnInput } from "@covel/shared";
import type { ToolModule } from "@covel/tools";
import type { TurnExecutorDeps } from "../turn-executor/turn-executor-types.js";
import type { PluginServiceRegistry } from "../plugin-services.js";
import type { ToolCallContext, ToolExecutor } from "./tool-executor.js";
import {
  absentImportTool,
  importedServiceTool,
  type AbsentImport,
} from "./service-import-tools.js";

/** The names of a runtime's generated tools, resolved or not. */
export function generatedToolNames(manifest: RuntimeManifest): string[] {
  if (manifest.runtimeType === "function") return [];
  return (manifest.tools?.services ?? []).map((entry) => entry.name);
}

export interface AgentToolSurface {
  /** Generated tools that resolved: advertised and callable. */
  readonly available: ReadonlyMap<string, ToolModule>;
  /** Generated tools that did not: callable only to answer `unavailable`. */
  readonly absent: ReadonlyMap<string, ToolModule>;
}

const EMPTY_SURFACE: AgentToolSurface = {
  available: new Map(),
  absent: new Map(),
};

/** Resolve a runtime's generated tools for one run, as that runtime. */
export async function prepareAgentToolSurface(args: {
  readonly manifest: RuntimeManifest;
  readonly input: Pick<TurnInput, "sessionId">;
  readonly deps: Pick<TurnExecutorDeps, "services">;
}): Promise<AgentToolSurface> {
  const { manifest, input, deps } = args;
  const imports =
    manifest.runtimeType === "function" ? [] : (manifest.tools?.services ?? []);
  if (imports.length === 0) return EMPTY_SURFACE;
  const available = new Map<string, ToolModule>();
  const absent = new Map<string, ToolModule>();
  for (const { contract, name } of imports) {
    let resolution: Awaited<ReturnType<PluginServiceRegistry["resolveImport"]>>;
    try {
      resolution = deps.services
        ? await deps.services.resolveImport(
            { sessionId: input.sessionId, pluginId: manifest.pluginId },
            contract,
          )
        : { status: "missing" };
    } catch (error) {
      // An import is optional: failing to resolve it leaves it out.
      console.warn(
        `[service-imports] runtime "${manifest.name}" could not resolve ${contract}:`,
        error,
      );
      resolution = { status: "missing" };
    }
    if (resolution.status === "ready") {
      available.set(name, importedServiceTool(name, resolution));
      continue;
    }
    absent.set(name, absentImportTool(name, contract, resolution));
    // The author's diagnostic; the model only learns that the tool is
    // unavailable, and why, without plugin IDs.
    console.info(
      `[service-imports] runtime "${manifest.name}" in session ${input.sessionId}: imported tool "${name}" (${contract}) is absent: ${absentReason(resolution)}`,
    );
  }
  return { available, absent };
}

function absentReason(absent: AbsentImport): string {
  switch (absent.status) {
    case "missing":
      return "no active, approved provider registers it";
    case "not-model-facing":
      return `its providers (${absent.providers.join(", ")}) do not offer it to models`;
    case "ambiguous":
      return `more than one provider offers it to models (${absent.providers.join(", ")})`;
    case "paused":
      return `its provider ${absent.pluginId} is paused after repeated errors`;
  }
}

/**
 * Hand every call the generated tools and the service registry, then
 * forward. Absent tools are left out of `getToolInfo` (so neither the
 * advertisement nor a tool search offers them) but answer `execute`.
 */
export function withAgentToolSurface(
  inner: ToolExecutor,
  surface: AgentToolSurface,
  services: PluginServiceRegistry | undefined,
): ToolExecutor {
  if (!services && surface.available.size === 0 && surface.absent.size === 0)
    return inner;
  const callable: ReadonlyMap<string, ToolModule> = new Map([
    ...surface.absent,
    ...surface.available,
  ]);
  const scope = (
    context: ToolCallContext,
    generatedTools: ReadonlyMap<string, ToolModule>,
  ): ToolCallContext => ({
    ...context,
    ...(services ? { services } : {}),
    ...(generatedTools.size > 0 ? { generatedTools } : {}),
  });
  return {
    getToolInfo: (name, context) =>
      inner.getToolInfo(name, scope(context, surface.available)),
    execute: (call, context) => inner.execute(call, scope(context, callable)),
  };
}
