/**
 * Structured output validation using JSON Schema (Ajv).
 */

import { Ajv } from "ajv";
import { Ajv2020 } from "ajv/dist/2020.js";
import type { ValidationResult } from "./types.js";

// Named import (not default): ajv's CJS `exports.default` isn't unwrapped
// under native Node ESM interop, which made the old default import
// non-constructable at runtime without an `any` cast. `exports.Ajv` is the
// same class exposed as a named export and needs no such workaround.
// Runtime/plugin schemas are independently loaded JSON objects and may reuse a
// public $id. Do not register validate-once schemas globally: Ajv otherwise
// throws when a hot reload or second plugin supplies a distinct object with
// the same id. Local $refs still compile within each validation call.
const ajvDraft7 = new Ajv({ allErrors: true, addUsedSchema: false });
const ajvDraft2020 = new Ajv2020({
  allErrors: true,
  addUsedSchema: false,
});

function validatorFor(schema: Readonly<Record<string, unknown>>) {
  return schema.$schema === "https://json-schema.org/draft/2020-12/schema"
    ? ajvDraft2020
    : ajvDraft7;
}

/**
 * Validate a runtime output against a JSON Schema.
 */
export function validateOutput(
  output: unknown,
  schema: Readonly<Record<string, unknown>>,
): ValidationResult {
  const ajv = validatorFor(schema);
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
