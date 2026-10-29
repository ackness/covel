import { z } from "zod";
import { StImportError } from "./report.js";

export const inputText = z.string().max(3 * 1024 * 1024);
const keys = z.array(inputText).max(100000);
export const loreEntrySchema = z.looseObject({
  keys: keys.optional(),
  key: keys.optional(),
  secondary_keys: keys.optional(),
  keysecondary: keys.optional(),
  content: inputText.optional(),
  name: inputText.optional(),
  comment: inputText.optional(),
  constant: z.boolean().optional(),
  enabled: z.boolean().optional(),
  disable: z.boolean().optional(),
  insertion_order: z.number().optional().catch(undefined),
  order: z.number().optional().catch(undefined),
  position: z.union([inputText, z.number()]).optional(),
  scanDepth: z.number().nullable().optional(),
});
export const lorebookSchema = z.looseObject({
  name: inputText.optional(),
  tags: z.array(inputText).max(10000).optional(),
  entries: z.union([
    z.array(loreEntrySchema).max(100000),
    z.record(z.string().max(200), loreEntrySchema),
  ]),
});
export type ParsedLoreEntry = z.infer<typeof loreEntrySchema>;
export interface ParsedLorebook {
  name?: string;
  tags?: string[];
  entries: ParsedLoreEntry[];
  ignored: string[];
}
export function parseLorebook(json: unknown): ParsedLorebook {
  const parsed = lorebookSchema.safeParse(json);
  if (!parsed.success)
    throw new StImportError("lorebook-invalid", "Invalid lorebook fields");
  const book = parsed.data;
  return {
    name: book.name,
    tags: book.tags,
    entries: Array.isArray(book.entries)
      ? book.entries
      : Object.values(book.entries),
    ignored: Object.keys(book).filter(
      (key) => !["name", "tags", "entries"].includes(key),
    ),
  };
}
