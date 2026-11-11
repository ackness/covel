import path from "node:path";
import type { RuntimeManifest } from "@covel/shared";
import { assertAgentOutputObjectSchema } from "@covel/shared/plugin-runtime";

/**
 * Shared admission after each path resolves its effective output schema.
 * File loading and contract resolution stay with the caller; this check
 * neither reads files nor imports plugin code.
 */
export function assertRuntimeOutputSchema(
  manifest: Pick<
    RuntimeManifest,
    "runtimeType" | "storyContext" | "outputContract"
  >,
  sourcePath: string | undefined,
  outputSchema: unknown,
): void {
  if (manifest.runtimeType === "function") return;
  if (outputSchema !== undefined) {
    try {
      assertAgentOutputObjectSchema(outputSchema);
    } catch (cause) {
      throw new Error(
        `${sourcePath}: ${cause instanceof Error ? cause.message : String(cause)}`,
        { cause },
      );
    }
    return;
  }
  // Only file-aware stages can also consider output.schema.json.
  if (!manifest.storyContext || manifest.outputContract !== undefined) return;
  const file = sourcePath ?? "PLUGIN.md";
  const field =
    path.basename(file) === "PLUGIN.md"
      ? "runtime.io.storyContext"
      : "io.storyContext";
  throw new Error(
    `${file}: ${field}: an agent runtime needs io.output.schema, an output.schema.json file beside its manifest, or an output contract: the note is read from its validated output`,
  );
}
