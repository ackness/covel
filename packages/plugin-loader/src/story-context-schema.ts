import path from "node:path";
import type { RuntimeManifest } from "@covel/shared";

/**
 * An agent's `io.storyContext` note is read from its validated output, so the
 * agent needs an output schema: `io.output.schema`, the conventional
 * `output.schema.json` beside its manifest, or an output contract. Only the
 * file-aware stages (loading and static validation) see the conventional
 * file, so the check lives here rather than in the shared manifest rules.
 *
 * Returns the error message, naming the manifest file and the author field,
 * or `undefined` when the runtime is fine.
 */
export function storyContextSchemaError(
  manifest: Pick<
    RuntimeManifest,
    "runtimeType" | "storyContext" | "outputContract"
  >,
  sourcePath: string | undefined,
  outputSchema: unknown,
): string | undefined {
  if (
    !manifest.storyContext ||
    manifest.runtimeType === "function" ||
    outputSchema !== undefined ||
    manifest.outputContract !== undefined
  )
    return undefined;
  const file = sourcePath ?? "PLUGIN.md";
  const field =
    path.basename(file) === "PLUGIN.md"
      ? "runtime.io.storyContext"
      : "io.storyContext";
  return `${file}: ${field}: an agent runtime needs io.output.schema, an output.schema.json file beside its manifest, or an output contract: the note is read from its validated output`;
}
