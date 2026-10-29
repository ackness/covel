import { z } from "zod";
import {
  inputText,
  lorebookSchema,
  loreEntrySchema,
} from "./lorebook-schema.js";
import { StImportError } from "./report.js";

export const cardFields = {
  name: inputText.optional(),
  nickname: inputText.optional(),
  description: inputText.optional(),
  personality: inputText.optional(),
  scenario: inputText.optional(),
  first_mes: inputText.optional(),
  mes_example: inputText.optional(),
  creator_notes: inputText.optional(),
  creator: inputText.optional(),
  system_prompt: inputText.optional(),
  post_history_instructions: inputText.optional(),
  tags: z.array(inputText).max(10000).optional(),
  alternate_greetings: z.array(inputText).max(10000).optional(),
  group_only_greetings: z.array(inputText).max(10000).optional(),
  character_book: lorebookSchema
    .extend({ entries: z.array(loreEntrySchema).max(100000) })
    .optional(),
  extensions: z.record(z.string(), z.unknown()).optional(),
};
export const cardSchema = z.looseObject(cardFields);
const envelopeSchema = z.looseObject({
  spec: inputText.optional(),
  spec_version: inputText.optional(),
  data: cardSchema.optional(),
});
export type ParsedCard = z.infer<typeof cardSchema> & {
  kind: "card-v1" | "card-v2" | "card-v3";
  ignored: string[];
};
export function parseCard(json: unknown): ParsedCard {
  const envelope = envelopeSchema.safeParse(json);
  if (!envelope.success)
    throw new StImportError("card-invalid", "Invalid character card envelope");
  const { spec, data } = envelope.data;
  if (
    spec !== undefined &&
    spec !== "chara_card_v2" &&
    spec !== "chara_card_v3"
  )
    throw new StImportError(
      "card-spec-unsupported",
      "Unsupported character card spec",
    );
  // Select individual known fields, data first; never copy input properties to output.
  const selected: Record<string, unknown> = {};
  for (const key of Object.keys(cardFields))
    selected[key] = data?.[key] ?? envelope.data[key];
  const parsed = cardSchema.safeParse(selected);
  if (!parsed.success)
    throw new StImportError("card-invalid", "Invalid character card fields");
  const known = new Set([
    ...Object.keys(cardFields),
    "data",
    "spec",
    "spec_version",
  ]);
  const ignored = [
    ...new Set(
      [...Object.keys(envelope.data), ...Object.keys(data ?? {})].filter(
        (key) => !known.has(key),
      ),
    ),
  ];
  return {
    ...parsed.data,
    kind:
      spec === "chara_card_v3"
        ? "card-v3"
        : spec === "chara_card_v2"
          ? "card-v2"
          : "card-v1",
    ignored,
  };
}
