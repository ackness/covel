/**
 * The part of a JSON Schema the composer can show as inputs. An action kind's
 * `fields` schema may be any JSON Schema the server validates, but the
 * composer draws only flat objects of strings, numbers and booleans. A kind
 * whose schema falls outside this subset is not offered in the composer, and
 * `validate:plugin` says so.
 */

/** One input of a kind's fields, in schema order. */
export type ComposerField = {
  readonly name: string;
  /** The schema `title`, else the property name. */
  readonly label: string;
  /** The schema `description`; shown as a placeholder. */
  readonly description?: string;
  readonly required: boolean;
} & (
  | { readonly control: "text" | "textarea" }
  | { readonly control: "checkbox" }
  | { readonly control: "select"; readonly options: readonly string[] }
  | {
      readonly control: "number";
      readonly integer: boolean;
      readonly minimum?: number;
      readonly maximum?: number;
    }
);

/** Strings longer than this get a multi-line input. */
export const COMPOSER_TEXTAREA_MIN_LENGTH = 200;

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function finite(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

function composerField(
  name: string,
  property: Record<string, unknown>,
  required: boolean,
): ComposerField | null {
  const base = {
    name,
    label:
      typeof property.title === "string" && property.title.trim()
        ? property.title
        : name,
    ...(typeof property.description === "string" && property.description
      ? { description: property.description }
      : {}),
    required,
  };
  for (const keyword of [
    "oneOf",
    "anyOf",
    "allOf",
    "not",
    "$ref",
    "items",
    "properties",
  ])
    if (keyword in property) return null;
  if (property.type === "boolean") return { ...base, control: "checkbox" };
  if (property.type === "number" || property.type === "integer") {
    if ("enum" in property) return null;
    const minimum = finite(property.minimum);
    const maximum = finite(property.maximum);
    return {
      ...base,
      control: "number",
      integer: property.type === "integer",
      ...(minimum !== undefined ? { minimum } : {}),
      ...(maximum !== undefined ? { maximum } : {}),
    };
  }
  if (property.type !== "string") return null;
  if ("enum" in property) {
    const options = property.enum;
    if (
      !Array.isArray(options) ||
      options.length === 0 ||
      !options.every((option) => typeof option === "string")
    )
      return null;
    return { ...base, control: "select", options: options as string[] };
  }
  const maxLength = finite(property.maxLength);
  return {
    ...base,
    control:
      maxLength !== undefined && maxLength > COMPOSER_TEXTAREA_MIN_LENGTH
        ? "textarea"
        : "text",
  };
}

/**
 * The inputs the composer shows for a kind's `fields` schema, or `null` when
 * the schema is outside the supported subset: a root `type: object` whose
 * `properties` are flat `string` (with `enum` as a select), `number`,
 * `integer` or `boolean`, and a `required` list that names only listed
 * properties. Other keywords (`additionalProperties`, `default`, limits the
 * server checks) are accepted and left to the server.
 */
export function composerFieldsOf(
  schema: Readonly<Record<string, unknown>>,
): ComposerField[] | null {
  if (schema.type !== "object") return null;
  for (const keyword of ["oneOf", "anyOf", "allOf", "not", "$ref", "if"])
    if (keyword in schema) return null;
  const properties = schema.properties === undefined ? {} : schema.properties;
  const entries = record(properties);
  if (!entries) return null;
  const requiredList = schema.required === undefined ? [] : schema.required;
  if (
    !Array.isArray(requiredList) ||
    !requiredList.every((name) => typeof name === "string" && name in entries)
  )
    return null;
  const required = new Set<string>(requiredList as string[]);
  const fields: ComposerField[] = [];
  for (const [name, raw] of Object.entries(entries)) {
    const property = record(raw);
    if (!property) return null;
    const field = composerField(name, property, required.has(name));
    if (!field) return null;
    fields.push(field);
  }
  return fields;
}
