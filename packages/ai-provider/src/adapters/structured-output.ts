import type { LLMResponseFormat } from "@covel/shared";
import { z, type ZodType } from "zod";
import { AiProviderError } from "../errors.js";
import type { TextMessage } from "../types.js";

/**
 * Describe the JSON before safeParse applies defaults and transforms.
 * Custom refinements still require safeParse: JSON Schema cannot express them.
 */
export function objectResponseFormat(
  schema: ZodType,
  provider: string,
): LLMResponseFormat {
  try {
    return {
      type: "json_schema",
      schema: z.toJSONSchema(schema, {
        io: "input",
        unrepresentable: "throw",
      }),
    };
  } catch (cause) {
    throw new AiProviderError({
      code: "CONFIG_ERROR",
      message:
        "Object generation requires a JSON Schema-representable input schema",
      provider,
      retriable: false,
      cause,
    });
  }
}

/** Reuse the runtime's schema marker without repeating an existing instruction. */
export function responseFormatInstruction(
  messages: readonly TextMessage[],
  responseFormat: LLMResponseFormat | undefined,
): string | undefined {
  if (!responseFormat) return undefined;
  const marker = `<response-format>${JSON.stringify(responseFormat.schema)}</response-format>`;
  const alreadyPresent = messages.some((message) => {
    if (message.role !== "system") return false;
    const content = message.content;
    return typeof content === "string"
      ? content.includes(marker)
      : content?.some(
          (part) => part.type === "text" && part.text.includes(marker),
        );
  });
  if (alreadyPresent) return undefined;
  return (
    "Return only JSON that conforms exactly to the following JSON Schema. " +
    "Do not add properties that the schema does not allow.\n" +
    marker
  );
}

export function withResponseFormatInstruction(
  messages: TextMessage[],
  responseFormat: LLMResponseFormat | undefined,
): TextMessage[] {
  const instruction = responseFormatInstruction(messages, responseFormat);
  if (!instruction) return messages;
  // A separate final system message leaves existing cacheable content intact.
  let lastSystem = -1;
  for (let index = 0; index < messages.length; index++) {
    if (messages[index]!.role === "system") lastSystem = index;
  }
  const next = [...messages];
  next.splice(lastSystem + 1, 0, { role: "system", content: instruction });
  return next;
}
