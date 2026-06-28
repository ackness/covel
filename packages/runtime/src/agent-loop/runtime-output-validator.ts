/**
 * Output validation for schema-declared agent runtimes.
 *
 * A runtime that declares `output.schema` (→ `loaded.outputSchema`) promised
 * the framework a structured JSON envelope. This module performs the two
 * checks `turn-agent-runtime.ts` used to inline:
 *   1. prose-instead-of-JSON — the model returned plain prose; surface a
 *      diagnostic so the task UI can explain the off-script output.
 *   2. schema-validation — the parsed envelope did not match the schema.
 *
 * Each returns a failed {@link RuntimeResult} (the caller emits `runtime.failed`
 * and runs the PostRuntime hook) or `undefined` when the output is acceptable.
 */

import type { RuntimeManifest, RuntimeResult, TurnInput } from "@covel/shared";
import type { ToolCallRecord } from "@covel/shared";
import { validateOutput } from "@covel/tools";
import { extractRequiredFields } from "../turn-executor/turn-output-helpers.js";

interface ValidatorContext {
  readonly manifest: RuntimeManifest;
  readonly input: TurnInput;
  readonly runId: string;
  readonly startTime: number;
  readonly collectedToolCalls: readonly ToolCallRecord[];
  readonly outputSchema: Record<string, unknown>;
}

/**
 * Check #1 — the model returned plain prose instead of the promised JSON
 * envelope. Returns a failed RuntimeResult that preserves the full LLM output
 * plus a structured diagnostic, or `undefined` when `parsedAsJson` is true.
 */
export function checkSchemaProseFailure(
  ctx: ValidatorContext,
  finalContent: string,
  parsedAsJson: boolean,
): RuntimeResult | undefined {
  if (parsedAsJson) return undefined;

  const {
    manifest,
    input,
    runId,
    startTime,
    collectedToolCalls,
    outputSchema,
  } = ctx;
  const preview = finalContent.slice(0, 220).replace(/\s+/g, " ").trim();
  const requiredFields = extractRequiredFields(outputSchema);
  const requiredHint =
    requiredFields.length > 0
      ? ` Required fields: {${requiredFields.join(", ")}}.`
      : "";

  return {
    pluginId: manifest.pluginId,
    runtimeId: manifest.name,
    runId,
    turnId: input.turnId,
    status: "failed",
    // Preserve the full LLM output (`narrativeOutput`) plus a structured
    // diagnostic the task UI can render verbatim. The shape is stable so a
    // plugin's jobs.json can bind `value/runtimeResults/0/output/diagnostic`
    // and show the user the schema contract + raw output side-by-side.
    output: {
      narrativeOutput: finalContent,
      diagnostic: {
        kind: "schema-validation-prose",
        requiredFields,
        schemaTitle:
          typeof outputSchema.title === "string"
            ? outputSchema.title
            : undefined,
        llmOutput: finalContent,
        hint:
          "Model returned plain prose instead of JSON. Try a model with reliable structured-output mode, " +
          "tighten the system prompt to enforce JSON, or relax overly strict schema fields.",
      },
    },
    toolCalls: [...collectedToolCalls],
    durationMs: Date.now() - startTime,
    error:
      `Runtime "${manifest.name}" expected a JSON envelope per output.schema but the model returned plain prose.` +
      requiredHint +
      ` Full LLM output preserved in runtimeResults[].output.narrativeOutput.` +
      ` Preview: "${preview}${finalContent.length > 220 ? "…" : ""}"`,
    timestamp: new Date().toISOString(),
  };
}

/**
 * Check #2 — validate the parsed output against the declared schema. Returns a
 * failed RuntimeResult on mismatch, or `undefined` when valid.
 */
export function checkSchemaValidation(
  ctx: ValidatorContext,
  output: Record<string, unknown>,
): RuntimeResult | undefined {
  const {
    manifest,
    input,
    runId,
    startTime,
    collectedToolCalls,
    outputSchema,
  } = ctx;
  const validation = validateOutput(output, outputSchema);
  if (validation.valid) return undefined;

  const validationErrors = validation.errors ?? [
    "unknown schema validation error",
  ];
  return {
    pluginId: manifest.pluginId,
    runtimeId: manifest.name,
    runId,
    turnId: input.turnId,
    status: "failed",
    output,
    toolCalls: [...collectedToolCalls],
    durationMs: Date.now() - startTime,
    error:
      `Runtime "${manifest.name}" output did not match output.schema: ` +
      validationErrors.slice(0, 5).join("; "),
    timestamp: new Date().toISOString(),
  };
}

export type { ValidatorContext };
