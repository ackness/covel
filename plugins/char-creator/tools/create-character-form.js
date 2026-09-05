/** Validate against the authoritative same-turn schema before showing a form. */
export default function ({ tool }, createFormTool) {
  return tool({
    name: "create-character-form",
    description:
      "Create the opening character form. Collect characterName and optional declared string/enum attributes only; retain numeric and compound attribute defaults.",
    parameters: createFormTool.parametersSchema,
    execute: async (params, context) => {
      const input = context.inputSlots?.["same-turn-world-schema"];
      const schema =
        input?.cardinality === "one"
          ? input.value?.["character-attributes"]
          : undefined;
      const attributes = new Map(
        (schema?.attributes ?? []).map((attribute) => [
          attribute.id,
          attribute,
        ]),
      );
      for (const field of params.fields) {
        if (
          field.name === "characterName" &&
          field.type === "text" &&
          field.required === true
        )
          continue;
        const attribute = attributes.get(field.name);
        if (!attribute || !["string", "enum"].includes(attribute.type)) {
          throw new Error(
            `Field ${field.name} cannot be collected as narrative text. Use only declared string/enum attributes, or collect characterName alone; keep numeric and compound defaults.`,
          );
        }
        if (
          attribute.type === "string" &&
          !["text", "textarea"].includes(field.type)
        ) {
          throw new Error(`Field ${field.name} requires a text input.`);
        }
        if (attribute.type === "enum") {
          const options =
            field.options?.map((option) =>
              typeof option === "string" ? option : option.value,
            ) ?? [];
          if (
            field.type !== "select" ||
            !options.length ||
            options.some((option) => !attribute.options?.includes(option))
          ) {
            throw new Error(
              `Field ${field.name} must use the world's exact enum options.`,
            );
          }
        }
      }
      if (
        !params.fields.some(
          (field) =>
            field.name === "characterName" &&
            field.type === "text" &&
            field.required === true,
        )
      ) {
        throw new Error("Include a required characterName text field.");
      }
      return createFormTool.execute(params, context);
    },
  });
}
