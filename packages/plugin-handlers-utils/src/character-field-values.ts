import type { CharacterAttributeSchema } from "./character-schema.js";
import { buildFieldsZodFromSchema } from "./character-fields.js";

/**
 * Merge declared attribute `defaultValue`s into a character's `fields` at the
 * WRITE boundary, so the stored record (and therefore the model's
 * `get-character` view and prompt context) matches what the right panel shows
 * — the panel overlays `fields[id] ?? attr.defaultValue` at render time, so
 * without this merge a default the player never typed appears in the UI but is
 * absent from stored state (a silent player↔model divergence).
 *
 * Returns a new object; never mutates the input. Only fills top-level
 * attributes whose id is absent and whose `defaultValue` is declared. A `null`
 * schema (not yet generated) returns the fields unchanged.
 */
export function mergeSchemaDefaults(
  fields: unknown,
  schema: CharacterAttributeSchema | null,
): Record<string, unknown> {
  const base: Record<string, unknown> =
    fields && typeof fields === "object" && !Array.isArray(fields)
      ? { ...(fields as Record<string, unknown>) }
      : {};
  if (!schema || !Array.isArray(schema.attributes)) return base;
  for (const attr of schema.attributes) {
    if (
      attr &&
      attr.defaultValue !== undefined &&
      base[attr.id] === undefined
    ) {
      base[attr.id] = attr.defaultValue;
    }
  }
  assertCharacterFields(base, schema);
  return base;
}

export class CharacterFieldValidationError extends Error {
  constructor(readonly issues: readonly { path: string; message: string }[]) {
    super(
      `Character attributes do not match the world schema: ${issues.map((issue) => `${issue.path}: ${issue.message}`).join("; ")}. Correct the submitted fields before continuing.`,
    );
    this.name = "CharacterFieldValidationError";
  }
}

/** Validate declared attribute types before producing any character write. */
export function assertCharacterFields(
  fields: unknown,
  schema: CharacterAttributeSchema | null,
): void {
  const validator = schema ? buildFieldsZodFromSchema(schema) : null;
  if (!validator) return;
  const parsed = validator.safeParse(fields);
  if (!parsed.success) {
    throw new CharacterFieldValidationError(
      parsed.error.issues.map((issue) => ({
        path: issue.path.join("."),
        message: issue.message,
      })),
    );
  }
}
