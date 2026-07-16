/**
 * Structured output validation using JSON Schema (Ajv).
 */

import { Ajv } from "ajv";
import type { ValidationResult } from "./types.js";

// Named import (not default): ajv's CJS `exports.default` isn't unwrapped
// under native Node ESM interop, which made the old default import
// non-constructable at runtime without an `any` cast. `exports.Ajv` is the
// same class exposed as a named export and needs no such workaround.
const ajv = new Ajv({ allErrors: true });

/**
 * Validate a runtime output against a JSON Schema.
 */
export function validateOutput(
  output: unknown,
  schema: Readonly<Record<string, unknown>>,
): ValidationResult {
  const valid = ajv.validate(schema, output) as boolean;

  if (valid) {
    return { valid: true };
  }

  const rawErrors = (ajv.errors ?? []) as Array<{
    instancePath?: string;
    message?: string;
  }>;
  const errors: readonly string[] = rawErrors.map(
    (err) => `${err.instancePath || "/"} ${err.message ?? "unknown error"}`,
  );

  return { valid: false, errors };
}
