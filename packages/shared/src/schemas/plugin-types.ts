/**
 * Types and semantic validation for PLUGIN.md frontmatter.
 *
 * Split from `plugin-schemas.ts` (the Zod definitions) so the schema bulk and
 * the derived types / semantic checks stay focused. `plugin.ts` re-exports both
 * — the public surface is unchanged.
 */

import type { z } from "zod";

import { FRAMEWORK_KNOWN_CAPABILITIES } from "../types/plugin.js";
import type { runtimeManifestSchema } from "./plugin-schemas.js";

export type RuntimeManifestInput = z.input<typeof runtimeManifestSchema>;

export type RuntimeManifestSemanticDiagnosticCode =
  "capability-typo" | "schedulable-missing-stage";

export interface RuntimeManifestSemanticDiagnostic {
  readonly code: RuntimeManifestSemanticDiagnosticCode;
  readonly severity: "warning";
  readonly path: readonly string[];
  readonly message: string;
}

/** Classic two-row Levenshtein — small inputs (capability tags), no dep. */
function editDistance(a: string, b: string): number {
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const curr = [i];
    for (let j = 1; j <= b.length; j++) {
      curr[j] = Math.min(
        prev[j] + 1,
        curr[j - 1] + 1,
        prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    prev = curr;
  }
  return prev[b.length];
}

export function validateRuntimeManifestSemantics(
  // `capabilities` / `trigger.type` are widened so both the zod input shape
  // (mutable) and the parsed RuntimeManifest (readonly) are accepted.
  manifest: Pick<RuntimeManifestInput, "name"> & {
    readonly trigger?: { readonly type?: string };
    readonly capabilities?: readonly string[];
    readonly stage?: string;
    readonly runtimeType?: string;
    readonly handler?: string;
    readonly model?: string;
    readonly ui?: unknown;
    readonly hooks?: unknown;
    readonly entry?: string;
    readonly wires?: string;
  },
): readonly RuntimeManifestSemanticDiagnostic[] {
  const diagnostics: RuntimeManifestSemanticDiagnostic[] = [];

  // A schedulable runtime (auto / scheduled — auto is the default when no
  // trigger is declared) that declares no `stage` normalizes to the
  // stage-less "UI-only" idiom: it is
  // NEVER selected by the scheduler and produces no diagnostic at run time.
  // That is correct for pure registration-surface declarations (UI panels,
  // hook carriers, `entry` server modules, `wires` modules — cost-gate,
  // memory), but for a runtime that clearly wants to execute (a function
  // handler, or an agent with a model) it means "installed but silently
  // never runs" — warn at load so the author finds out here.
  {
    const triggerType = manifest.trigger?.type ?? "auto";
    const isSchedulable = triggerType === "auto" || triggerType === "scheduled";
    const hasStageSignal = manifest.stage !== undefined;
    const isRegistrationOnlyIdiom =
      (manifest.ui !== undefined ||
        manifest.hooks !== undefined ||
        manifest.entry !== undefined ||
        manifest.wires !== undefined) &&
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
          "or add a ui/hooks declaration if it is intentionally UI-only.",
      });
    }
  }

  // Capability tags are free-form, but the framework matches them exactly —
  // a misspelled framework-known tag is silently never discovered (no error,
  // no log, the provider just doesn't exist). Warn when a declared tag sits
  // one edit away from a known one (two for long tags), which is a typo far
  // more often than a deliberate near-identical custom tag.
  for (const cap of manifest.capabilities ?? []) {
    if (FRAMEWORK_KNOWN_CAPABILITIES.includes(cap)) continue;
    const near = FRAMEWORK_KNOWN_CAPABILITIES.find(
      (known) => editDistance(cap, known) <= (known.length >= 10 ? 2 : 1),
    );
    if (near) {
      diagnostics.push({
        code: "capability-typo",
        severity: "warning",
        path: ["capabilities"],
        message:
          `Runtime "${manifest.name}" declares capability "${cap}" which looks like a typo of ` +
          `framework-known "${near}". Capabilities are matched exactly — a misspelled tag is ` +
          "silently never discovered by the framework.",
      });
    }
  }

  return diagnostics;
}
