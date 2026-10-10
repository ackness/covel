import type { DimensionValueSchema, JsonValue } from "@covel/shared";
import {
  emptyValue,
  supportsDimensionFields,
} from "./dimension-value-editor.js";

/** The control a suspension's resume schema calls for. */
export type SuspensionInput =
  | { readonly kind: "confirm" }
  | { readonly kind: "choice"; readonly options: readonly JsonValue[] }
  | { readonly kind: "text" }
  | { readonly kind: "form"; readonly schema: DimensionValueSchema }
  // The schema is missing or describes something no control covers.
  | { readonly kind: "advanced" };

function isPrimitive(value: unknown): value is string | number | boolean {
  return (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  );
}

function schemaType(schema: Record<string, unknown>): unknown {
  const type = schema["type"];
  return Array.isArray(type) ? type.find((item) => item !== "null") : type;
}

/** Choose the answer control for a suspension's `resumeSchema`. */
export function classifySuspensionInput(
  resumeSchema: unknown,
): SuspensionInput {
  if (
    resumeSchema === null ||
    typeof resumeSchema !== "object" ||
    Array.isArray(resumeSchema)
  )
    return { kind: "advanced" };
  const schema = resumeSchema as Record<string, unknown>;

  const options = schema["enum"];
  if (
    Array.isArray(options) &&
    options.length > 0 &&
    options.every(isPrimitive)
  )
    return { kind: "choice", options };
  for (const key of ["oneOf", "anyOf"]) {
    const variants = schema[key];
    if (
      Array.isArray(variants) &&
      variants.length > 0 &&
      variants.every(
        (variant) =>
          variant !== null &&
          typeof variant === "object" &&
          isPrimitive((variant as Record<string, unknown>)["const"]),
      )
    )
      return {
        kind: "choice",
        options: variants.map(
          (variant) => (variant as { const: JsonValue }).const,
        ),
      };
  }

  const type = schemaType(schema);
  if (type === "boolean") return { kind: "confirm" };
  if (type === "string") return { kind: "text" };

  const typed = schema as DimensionValueSchema;
  if (supportsDimensionFields(typed, emptyValue(typed)))
    return { kind: "form", schema: typed };
  return { kind: "advanced" };
}
