/**
 * Types and semantic validation for PLUGIN.md frontmatter.
 *
 * Split from `plugin-schemas.ts` (the Zod definitions) so the schema bulk and
 * the derived types / semantic checks stay focused. `plugin.ts` re-exports both
 * — the public surface is unchanged.
 */

import type { z } from "zod";

import type { runtimeManifestInputSchema } from "./plugin-schemas.js";

export type RuntimeManifestInput = z.input<typeof runtimeManifestInputSchema>;

export type RuntimeManifestSemanticDiagnosticCode = "schedulable-missing-stage";

export interface RuntimeManifestSemanticDiagnostic {
  readonly code: RuntimeManifestSemanticDiagnosticCode;
  readonly severity: "warning";
  readonly path: readonly string[];
  readonly message: string;
}

export function validateRuntimeManifestSemantics(
  // `capabilities` / `trigger.type` are widened so both the zod input shape
  // (mutable) and the parsed RuntimeManifest (readonly) are accepted.
  manifest: Pick<RuntimeManifestInput, "name"> & {
    readonly trigger?: { readonly type?: string };
    readonly stage?: string;
    readonly runtimeType?: string;
    readonly handler?: string;
    readonly model?: string;
    readonly ui?: unknown;
    readonly entry?: string;
  },
): readonly RuntimeManifestSemanticDiagnostic[] {
  const diagnostics: RuntimeManifestSemanticDiagnostic[] = [];

  // A schedulable runtime (auto / scheduled — auto is the default when no
  // trigger is declared) that declares no `stage` normalizes to the
  // stage-less "UI-only" idiom: it is
  // NEVER selected by the scheduler and produces no diagnostic at run time.
  // That is correct for pure registration-surface declarations (UI panels,
  // hook carriers, `entry` server modules, `wires` modules — history-compaction,
  // memory), but for a runtime that clearly wants to execute (a function
  // handler, or an agent with a model) it means "installed but silently
  // never runs" — warn at load so the author finds out here.
  {
    const triggerType = manifest.trigger?.type ?? "auto";
    const isSchedulable = triggerType === "auto" || triggerType === "scheduled";
    const hasStageSignal = manifest.stage !== undefined;
    const isRegistrationOnlyIdiom =
      (manifest.ui !== undefined || manifest.entry !== undefined) &&
      manifest.handler === undefined &&
      manifest.runtimeType !== "function" &&
      manifest.model === undefined;
    if (isSchedulable && !hasStageSignal && !isRegistrationOnlyIdiom) {
      diagnostics.push({
        code: "schedulable-missing-stage",
        severity: "warning",
        path: ["stage"],
        message:
          `Runtime "${manifest.name}" has trigger.type='${triggerType}' but declares no stage — ` +
          "it will NEVER be scheduled (stage-less runtimes are treated as UI-only declarations). " +
          "Declare a stage (setup / pre-turn / narrative / post-turn / audit) to run it, " +
          "or add a ui/entry declaration if it is intentionally UI-only.",
      });
    }
  }

  return diagnostics;
}
