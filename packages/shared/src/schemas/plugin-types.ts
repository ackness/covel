/**
 * Types and semantic validation for PLUGIN.md frontmatter.
 *
 * Split from `plugin-schemas.ts` (the Zod definitions) so the schema bulk and
 * the derived types / semantic checks stay focused. `plugin.ts` re-exports both
 * — the public surface is unchanged.
 */

import type { z } from "zod";

import type { runtimeManifestSchema } from "./plugin-schemas.js";

export type RuntimeManifestInput = z.input<typeof runtimeManifestSchema>;

export type RuntimeManifestSemanticDiagnosticCode = "manual-trigger-priority";

export interface RuntimeManifestSemanticDiagnostic {
  readonly code: RuntimeManifestSemanticDiagnosticCode;
  readonly severity: "warning";
  readonly path: readonly string[];
  readonly message: string;
}

export function validateRuntimeManifestSemantics(
  manifest: Pick<RuntimeManifestInput, "name" | "priority" | "trigger">,
): readonly RuntimeManifestSemanticDiagnostic[] {
  if (
    manifest.trigger?.type === "manual" &&
    typeof manifest.priority === "number"
  ) {
    return [
      {
        code: "manual-trigger-priority",
        severity: "warning",
        path: ["priority"],
        message:
          `Runtime "${manifest.name}" declares trigger.type='manual' but also sets priority=${manifest.priority}. ` +
          "Manual runtimes are UI-only and should omit priority entirely.",
      },
    ];
  }
  return [];
}
