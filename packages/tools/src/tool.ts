/**
 * tool() wrapper function — defines a type-safe tool for the Covel framework.
 */

import type { ZodType } from "zod";
import { ZodError } from "zod";
import type { ToolExecutionEnvelope } from "./result.js";
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
		// Zod v4 uses .issues; v3 uses .errors (aliased to .issues in v4)
		const issues =
			(
				zodError as unknown as {
					issues?: Array<{ path: (string | number)[]; message: string }>;
				}
			).issues ??
			(
				zodError as unknown as {
					errors?: Array<{ path: (string | number)[]; message: string }>;
				}
			).errors ??
			[];
		this.details = issues.map((issue) => ({
			path: issue.path.join(".") || "(root)",
			message: issue.message,
		}));
	}
}

/**
 * Define a Covel tool with type-safe parameters and execution.
 *
 * Automatically converts the Zod parameters schema to JSON Schema
 * for use with LLM function calling APIs. The returned `ToolModule`
 * validates incoming params at runtime before calling `execute`.
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
		// Zod v4 ships toJSONSchema() natively. Cast through unknown to avoid the type
		// mismatch between the v4 ZodType shape used at compile time and the runtime type.
		type ZodV4WithSchema = { toJSONSchema(): Record<string, unknown> };
		const params = definition.parameters as unknown as ZodV4WithSchema;
		const raw = params.toJSONSchema();
		// Strip $schema — LLM APIs don't need it and some reject it
		const { $schema: _drop, ...rest } = raw;
		jsonSchema = rest;
	} catch {
		jsonSchema = { type: "object" };
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
		): Promise<TOutput | ToolExecutionEnvelope<TOutput>> {
			let validated: unknown;
			try {
				validated = definition.parameters.parse(params);
			} catch (err) {
				if (err instanceof ZodError) {
					throw new ToolValidationError(err);
				}
				throw err;
			}
			// Safe: Zod's .parse() guarantees the output matches TParams' output type
			return definition.execute(
				validated as Parameters<typeof definition.execute>[0],
				context,
			);
		},
	};
}
