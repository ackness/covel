import type { RuntimeManifest, TurnInput } from "@covel/shared";
import type { AgentLoopDeps } from "../turn-executor/turn-executor-types.js";

/** Resolve the runtime's text slot before per-call hooks and provider fallback. */
export function resolveRuntimeModel(
  manifest: RuntimeManifest,
  input: Pick<TurnInput, "modelOverride" | "runtimeModelOverrides">,
  deps: Pick<AgentLoopDeps, "resolveModel">,
): string | undefined {
  // Function handlers use their declared default or select a slot per call.
  if (manifest.runtimeType === "function") return manifest.model;
  const override =
    input.modelOverride && manifest.outputKind === "story"
      ? input.modelOverride
      : input.runtimeModelOverrides?.[manifest.name];
  return deps.resolveModel
    ? deps.resolveModel(manifest, override)
    : (override ?? manifest.model);
}
