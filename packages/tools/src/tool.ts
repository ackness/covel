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

  /**
   * @param messages - A more specific message for an issue path, used in
   *   place of Zod's when one exists.
   */
  constructor(zodError: ZodError, messages?: ReadonlyMap<string, string>) {
    super("Tool parameter validation failed");
    this.name = "ToolValidationError";
    this.details = zodError.issues.map((issue) => {
      const path = issue.path.join(".");
      return {
        path: path || "(root)",
        message:
          (issue.code === "invalid_type" ? messages?.get(path) : undefined) ??
          issue.message,
      };
    });
  }
}

type Issue = ZodError["issues"][number];

const isStructure = (value: unknown, expected: string): boolean =>
  expected === "array"
    ? Array.isArray(value)
    : value !== null && typeof value === "object" && !Array.isArray(value);

/**
 * Say why a string cannot stand in for the array or object the schema
 * expects. "Expected array, received string" alone does not tell a model
 * what to change: it sends the same broken text again, several times.
 */
function jsonTextProblem(
  text: string,
  expected: string,
  parseError?: unknown,
): string {
  const structure = expected === "array" ? "an array" : "an object";
  const send = `Send ${expected === "array" ? "the array" : "the object"} itself as the value, not a string that contains it.`;
  if (parseError === undefined)
    return `Expected ${structure}, but received text that holds another JSON type. ${send}`;
  const reason = parseError instanceof Error ? parseError.message : "";
  const position = Number(/position (\d+)/.exec(reason)?.[1]);
  const near = Number.isInteger(position)
    ? ` near \`${text.slice(Math.max(0, position - 40), position + 20)}\``
    : "";
  return `Expected ${structure}, but received text that is not valid JSON: ${reason.slice(0, 160)}${near}. ${send}`;
}

/** How many closing brackets after a complete JSON value are dropped. */
const EXTRA_CLOSERS = 4;

/**
 * Parse JSON text that may end with closing brackets it does not need.
 *
 * A model that writes an array as text often closes the arguments object
 * inside the text as well: `[{"id":1}]}`. In real-model runs this was more
 * than half of the JSON text that did not parse. The value before the extra
 * brackets is complete, so they are dropped: nothing inside the value
 * changes. Text that is broken anywhere else still fails.
 */
function parseJsonText(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch (error) {
    let rest = text.trimEnd();
    for (let dropped = 0; dropped < EXTRA_CLOSERS; dropped += 1) {
      if (!/[\]}]$/.test(rest)) break;
      rest = rest.slice(0, -1).trimEnd();
      try {
        return JSON.parse(rest);
      } catch {
        // One bracket fewer on the next pass.
      }
    }
    throw error;
  }
}

/**
 * Models sometimes send an array or object argument as its JSON text.
 * Parse such strings where the schema expects that structure, so the call
 * succeeds instead of costing another model round trip. `repaired` is
 * undefined when no issue is of that kind. `problems` explains, by issue
 * path, each such string that could not be used.
 */
function withParsedJsonText(
  params: unknown,
  issues: readonly Issue[],
): { repaired: unknown; problems: Map<string, string> } {
  const problems = new Map<string, string>();
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
    const text = record[key];
    if (typeof text !== "string") continue;
    // An ordinary sentence is not an attempt at JSON: the schema's own
    // "expected object, received string" already describes it.
    if (!/^\s*[[{]/.test(text)) continue;
    const path = issue.path.join(".");
    try {
      const parsed: unknown = parseJsonText(text);
      if (isStructure(parsed, issue.expected)) record[key] = parsed;
      else problems.set(path, jsonTextProblem(text, issue.expected));
    } catch (error) {
      // Broken JSON text; the issue stands, with the reason attached.
      problems.set(path, jsonTextProblem(text, issue.expected, error));
    }
  }
  return { repaired, problems };
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
      let problems: ReadonlyMap<string, string> | undefined;
      if (!result.success) {
        const parsed = withParsedJsonText(params, result.error.issues);
        problems = parsed.problems;
        if (parsed.repaired !== undefined)
          result = definition.parameters.safeParse(parsed.repaired);
      }
      if (!result.success)
        throw new ToolValidationError(result.error, problems);
      const validated: unknown = result.data;
      // Safe: Zod's .parse() guarantees the output matches TParams' output type
      return definition.execute(
        validated as Parameters<typeof definition.execute>[0],
        context,
      );
    },
  };
}
