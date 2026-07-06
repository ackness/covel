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
  | "manual-trigger-priority"
  | "capability-typo";

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
  // `capabilities` is widened to readonly so both the zod input shape
  // (mutable) and the parsed RuntimeManifest (readonly) are accepted.
  manifest: Pick<RuntimeManifestInput, "name" | "priority" | "trigger"> & {
    readonly capabilities?: readonly string[];
  },
): readonly RuntimeManifestSemanticDiagnostic[] {
  const diagnostics: RuntimeManifestSemanticDiagnostic[] = [];

  if (
    manifest.trigger?.type === "manual" &&
    typeof manifest.priority === "number"
  ) {
    diagnostics.push({
      code: "manual-trigger-priority",
      severity: "warning",
      path: ["priority"],
      message:
        `Runtime "${manifest.name}" declares trigger.type='manual' but also sets priority=${manifest.priority}. ` +
        "Manual runtimes are UI-only and should omit priority entirely. " +
        "Remove one of the two to keep the scheduler intent clear.",
    });
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
