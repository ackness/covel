/**
 * Structured output validation using JSON Schema (Ajv).
 */

import Ajv from 'ajv';
import type { ValidationResult, StructuredOutputStrategy } from './types.js';

/* eslint-disable @typescript-eslint/no-explicit-any */
const AjvCtor = (Ajv as any).default ?? Ajv;
const ajv = new AjvCtor({ allErrors: true }) as any;
/* eslint-enable @typescript-eslint/no-explicit-any */

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

  const rawErrors = (ajv.errors ?? []) as Array<{ instancePath?: string; message?: string }>;
  const errors: readonly string[] = rawErrors.map(
    (err) => `${err.instancePath || '/'} ${err.message ?? 'unknown error'}`,
  );

  return { valid: false, errors };
}

/**
 * Select the structured output strategy based on model capabilities.
 */
export function selectOutputStrategy(
  supportsNativeJsonSchema: boolean,
): StructuredOutputStrategy {
  return supportsNativeJsonSchema ? 'native' : 'prompt';
}

/**
 * Generate the prompt injection text for models that don't support native structured output.
 */
export function generateSchemaPrompt(
  schema: Readonly<Record<string, unknown>>,
): string {
  const schemaStr = JSON.stringify(schema, null, 2);

  return `## Output Format

You MUST respond with valid JSON matching this schema:

\`\`\`json
${schemaStr}
\`\`\`

Do not include any text outside the JSON object.`;
}
