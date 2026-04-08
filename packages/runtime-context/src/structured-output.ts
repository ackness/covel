import type { StructuredOutputConfig, StructuredOutputStrategy } from "./types.js";

/**
 * Minimal JSON-schema validator.
 * Checks required fields and basic type constraints.
 * In production, use Ajv or Zod for full validation.
 */
export function validateJsonSchema(data: unknown, schema: Record<string, unknown>): ValidationResult {
  const errors: string[] = [];
  validateNode(data, schema, "", errors);

  return errors.length === 0
    ? { valid: true, errors: [] }
    : { valid: false, errors };
}

function validateNode(
  data: unknown,
  schema: Record<string, unknown>,
  path: string,
  errors: string[],
): void {
  const typeSpec = schema.type as string | string[] | undefined;
  if (typeSpec && !matchesType(data, typeSpec)) {
    errors.push(`${formatPath(path)} expected ${Array.isArray(typeSpec) ? typeSpec.join("|") : typeSpec}, got ${actualTypeOf(data)}`);
    return;
  }

  if (schema.enum && Array.isArray(schema.enum) && !schema.enum.some((value) => Object.is(value, data))) {
    errors.push(`${formatPath(path)} must be one of ${schema.enum.join(", ")}`);
    return;
  }

  const expectedType = resolvePrimaryType(typeSpec, data);
  if (expectedType === "object" && typeof data === "object" && data !== null && !Array.isArray(data)) {
    const obj = data as Record<string, unknown>;
    const properties = schema.properties as Record<string, Record<string, unknown>> | undefined;
    const required = schema.required as string[] | undefined;

    if (required) {
      for (const field of required) {
        if (!(field in obj)) {
          errors.push(`Missing required field: ${path ? `${path}.${field}` : field}`);
        }
      }
    }

    if (schema.additionalProperties === false && properties) {
      for (const key of Object.keys(obj)) {
        if (!(key in properties)) {
          errors.push(`${formatPath(path ? `${path}.${key}` : key)} is not allowed`);
        }
      }
    }

    if (properties) {
      for (const [key, propSchema] of Object.entries(properties)) {
        if (obj[key] === undefined) continue;
        validateNode(obj[key], propSchema, path ? `${path}.${key}` : key, errors);
      }
    }
    return;
  }

  if (expectedType === "array") {
    const itemsSchema = schema.items as Record<string, unknown> | undefined;
    if (Array.isArray(data) && itemsSchema) {
      data.forEach((item, index) => {
        validateNode(item, itemsSchema, `${path}[${index}]`, errors);
      });
    }
    return;
  }

  if (expectedType === "number" || expectedType === "integer") {
    if (typeof data === "number") {
      const minimum = schema.minimum as number | undefined;
      const maximum = schema.maximum as number | undefined;
      if (minimum !== undefined && data < minimum) {
        errors.push(`${formatPath(path)} must be >= ${minimum}`);
      }
      if (maximum !== undefined && data > maximum) {
        errors.push(`${formatPath(path)} must be <= ${maximum}`);
      }
    }
  }
}

function matchesType(data: unknown, typeSpec: string | string[]): boolean {
  const allowed = Array.isArray(typeSpec) ? typeSpec : [typeSpec];
  return allowed.some((type) => {
    switch (type) {
      case "object":
        return typeof data === "object" && data !== null && !Array.isArray(data);
      case "array":
        return Array.isArray(data);
      case "integer":
        return typeof data === "number" && Number.isInteger(data);
      case "number":
        return typeof data === "number";
      case "string":
        return typeof data === "string";
      case "boolean":
        return typeof data === "boolean";
      case "null":
        return data === null;
      default:
        return true;
    }
  });
}

function resolvePrimaryType(typeSpec: string | string[] | undefined, data: unknown): string | undefined {
  if (!typeSpec) return undefined;
  if (Array.isArray(typeSpec)) {
    return typeSpec.find((type) => matchesType(data, type)) ?? typeSpec[0];
  }
  return typeSpec;
}

function actualTypeOf(data: unknown): string {
  if (data === null) return "null";
  if (Array.isArray(data)) return "array";
  if (typeof data === "number" && Number.isInteger(data)) return "integer";
  return typeof data;
}

function formatPath(path: string): string {
  return path || "value";
}

export interface ValidationResult {
  valid: boolean;
  errors: string[];
}

/**
 * Try to parse and validate structured output.
 *
 * Strategies (tried in order):
 * 1. native — assume the model returned valid JSON directly
 * 2. function_calling — extract from function call result
 * 3. prompt_retry — re-prompt the model with validation errors
 *
 * This function handles strategy 1 (native parse + validate).
 * Strategies 2-3 require LLM interaction and are handled by the kernel.
 */
export function parseStructuredOutput(
  raw: string,
  config: StructuredOutputConfig,
): StructuredOutputParseResult {
  // Try to extract JSON from the raw text
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // Try to find JSON block in markdown
    const jsonMatch = raw.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
    if (jsonMatch) {
      try {
        parsed = JSON.parse(jsonMatch[1]);
      } catch {
        return {
          success: false,
          strategy: "native",
          errors: ["Could not parse JSON from output."],
        };
      }
    } else {
      return {
        success: false,
        strategy: "native",
        errors: ["Output is not valid JSON."],
      };
    }
  }

  const validation = validateJsonSchema(parsed, config.outputSchema);
  if (!validation.valid) {
    return {
      success: false,
      strategy: "native",
      data: parsed,
      errors: validation.errors,
    };
  }

  return {
    success: true,
    strategy: "native",
    data: parsed,
    errors: [],
  };
}

export interface StructuredOutputParseResult {
  success: boolean;
  strategy: StructuredOutputStrategy;
  data?: unknown;
  errors: string[];
}
