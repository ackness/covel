import type { FormField } from "@covel/plugin-handlers-utils";

/** Compile form answers to the JSON Schema stored and validated on resume. */
export function suspendFieldsToResumeSchema(
  fields: readonly FormField[],
): Record<string, unknown> {
  const properties = Object.fromEntries(
    fields.map((field) => {
      const property: Record<string, unknown> = {
        type:
          field.type === "number"
            ? "number"
            : field.type === "checkbox"
              ? "boolean"
              : "string",
        title: field.label,
      };
      if (
        (field.type === "text" || field.type === "textarea") &&
        field.required
      )
        property.minLength = 1;
      if (field.type === "number") {
        if (field.min !== undefined) property.minimum = field.min;
        if (field.max !== undefined) property.maximum = field.max;
      }
      if (field.type === "select")
        property.enum = (field.options ?? []).map((option) =>
          typeof option === "string" ? option : option.value,
        );
      if (field.defaultValue !== undefined)
        property.default = field.defaultValue;
      return [field.name, property];
    }),
  );
  const required = fields
    .filter((field) => field.required)
    .map((field) => field.name);
  return {
    type: "object",
    properties,
    ...(required.length ? { required } : {}),
    additionalProperties: false,
  };
}
