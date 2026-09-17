import { z } from "zod";
import {
  REASONING_EFFORT_VALUES,
  type ModelParameterOverrides,
} from "@covel/ai-provider";

const publicParameters = z.object({
  temperature: z.number().finite().optional(),
  topP: z.number().finite().optional(),
  topK: z.number().finite().optional(),
  maxOutputTokens: z.number().int().positive().optional(),
  frequencyPenalty: z.number().finite().optional(),
  presencePenalty: z.number().finite().optional(),
  reasoningEffort: z.enum(REASONING_EFFORT_VALUES).optional(),
});

/** Public configuration must not expose freeform provider metadata or keys. */
export function modelParameters(
  metadata: Record<string, unknown> | undefined,
  slotParameters?: ModelParameterOverrides,
): ModelParameterOverrides | undefined {
  const defaults = publicParameters.safeParse(metadata?.parameterOverrides);
  const parameters = {
    ...(defaults.success ? defaults.data : {}),
    ...slotParameters,
  };
  return Object.keys(parameters).length ? parameters : undefined;
}
