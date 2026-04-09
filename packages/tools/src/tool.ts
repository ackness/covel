/**
 * tool() wrapper function — defines a type-safe tool for the Covel framework.
 */

import type { ZodType } from 'zod';
import type { ToolDefinitionInput, ToolExecutionContext, ToolModule } from './types.js';

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
    const schemaFn = (definition.parameters as ZodType & { toJSONSchema?: () => Record<string, unknown> }).toJSONSchema;
    jsonSchema = schemaFn ? schemaFn.call(definition.parameters) : { type: 'object' };
  } catch {
    jsonSchema = { type: 'object' };
  }

  return {
    _type: 'covel-tool',
    name: definition.name,
    description: definition.description,
    parametersSchema: definition.parameters,
    jsonSchema,
    async execute(params: unknown, context: ToolExecutionContext): Promise<TOutput> {
      const validated = definition.parameters.parse(params);
      return definition.execute(validated, context);
    },
  };
}
