/**
 * tool() wrapper function — defines a type-safe tool for the Covel framework.
 */

import type { ZodType } from "zod";
import { ZodError } from "zod";
import type {
  ToolDefinitionInput,
  ToolExecutionContext,
  ToolModule,
} from "./types.js";

/**
 * Thrown when LLM-supplied parameters fail Zod validation.
 * Carries field-level details so `ToolExecutor` can return a structured
 * error that the LLM can understand and act on (fix the call, not retry blindly).
 */
export class ToolValidationError extends Error {
  readonly code = "VALIDATION_ERROR" as const;
  readonly details: Array<{ path: string; message: string }>;

  constructor(zodError: ZodError) {
    super("Tool parameter validation failed");
    this.name = "ToolValidationError";
    this.details = zodError.issues.map((issue) => ({
      path: issue.path.join(".") || "(root)",
      message: issue.message,
    }));
  }
}

type Issue = ZodError["issues"][number];

const isStructure = (value: unknown, expected: string): boolean =>
  expected === "array"
    ? Array.isArray(value)
    : value !== null && typeof value === "object" && !Array.isArray(value);

/**
 * Models sometimes send an array or object argument as its JSON text.
 * Parse such strings where the schema expects that structure, so the call
 * succeeds instead of costing another model round trip. Returns undefined
 * when no issue is of that kind.
 */
function withParsedJsonText(
  params: unknown,
  issues: readonly Issue[],
): unknown {
  let repaired: unknown;
  for (const issue of issues) {
    if (
      issue.code !== "invalid_type" ||
      (issue.expected !== "array" && issue.expected !== "object") ||
      issue.path.length === 0
    )
      continue;
    repaired ??= structuredClone(params);
    let parent: unknown = repaired;
    for (const key of issue.path.slice(0, -1))
      parent = (parent as Record<PropertyKey, unknown> | undefined)?.[key];
    if (parent === null || typeof parent !== "object") continue;
    const record = parent as Record<PropertyKey, unknown>;
    const key = issue.path[issue.path.length - 1]!;
    if (typeof record[key] !== "string") continue;
    try {
      const parsed: unknown = JSON.parse(record[key]);
      if (isStructure(parsed, issue.expected)) record[key] = parsed;
    } catch {
      // Not JSON text; the original issue stands.
    }
  }
  return repaired;
}

/**
 * Define a Covel tool with type-safe parameters and execution.
 *
 * Automatically converts the Zod parameters schema to JSON Schema
 * for use with LLM function calling APIs. The returned `ToolModule`
 * validates incoming params at runtime before calling `execute`, parsing an
 * array or object argument the model sent as JSON text.
 *
 * @param definition - Tool definition including name, description, Zod parameters schema, and execute handler.
 * @returns A fully-formed `ToolModule` ready for registration with the plugin system.
 *
 * @example
 * ```typescript
 * import { tool } from '@covel/tools';
 * import { z } from 'zod';
 *
 * export default tool({
 *   name: 'get-weather',
 *   description: 'Get current weather for a city',
 *   parameters: z.object({
 *     city: z.string().describe('City name'),
 *   }),
 *   execute: async ({ city }) => {
 *     return { temp: 22, condition: 'sunny' };
 *   },
 * });
 * ```
 */
export function tool<TParams extends ZodType, TOutput>(
  definition: ToolDefinitionInput<TParams, TOutput>,
): ToolModule<TParams, TOutput> {
  let jsonSchema: Readonly<Record<string, unknown>>;
  try {
    // Models supply the input shape; execute receives Zod's parsed output.
    const raw = definition.parameters.toJSONSchema({ io: "input" });
    // Strip $schema — LLM APIs don't need it and some reject it
    const { $schema: _drop, ...rest } = raw;
    jsonSchema = rest;
  } catch (cause) {
    throw new Error(
      `Tool "${definition.name}" parameters cannot be represented as JSON Schema: ${cause instanceof Error ? cause.message : String(cause)}`,
      { cause },
    );
  }

  return {
    _type: "covel-tool",
    name: definition.name,
    description: definition.description,
    parametersSchema: definition.parameters,
    jsonSchema,
    async execute(
      params: unknown,
      context: ToolExecutionContext,
    ): Promise<TOutput> {
      let result = definition.parameters.safeParse(params);
      if (!result.success) {
        const repaired = withParsedJsonText(params, result.error.issues);
        if (repaired !== undefined)
          result = definition.parameters.safeParse(repaired);
      }
      if (!result.success) throw new ToolValidationError(result.error);
      const validated: unknown = result.data;
      // Safe: Zod's .parse() guarantees the output matches TParams' output type
      return definition.execute(
        validated as Parameters<typeof definition.execute>[0],
        context,
      );
    },
  };
}
