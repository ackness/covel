const COLLECTABLE_TYPES = ["string", "enum"];
const CHARACTER_FORM_ID = "char-creation";

/**
 * What the form may hold in this world, written for the model: a rejection
 * that only says "not allowed" makes it guess the next field.
 */
function collectableFields(attributes) {
  const usable = [...attributes.values()].filter((attribute) =>
    COLLECTABLE_TYPES.includes(attribute.type),
  );
  if (!usable.length)
    return "This world declares no string or enum attribute, so the form has one field: characterName. Write the other details as fixed text in narrativeTemplate.";
  const list = usable
    .map((attribute) =>
      attribute.type === "enum"
        ? `${attribute.id} (enum: ${(attribute.options ?? []).join(" | ")})`
        : `${attribute.id} (string)`,
    )
    .join(", ");
  return `The form may hold characterName and these attributes of the world: ${list}. Remove every other field, and its placeholder in narrativeTemplate.`;
}

/** Validate against the authoritative same-turn schema before showing a form. */
export default function ({ tool }, createFormTool) {
  return tool({
    name: "create-character-form",
    description:
      "Create the opening character form. Collect characterName and optional declared string/enum attributes only; retain numeric and compound attribute defaults.",
    // This plugin has no registered form validators; keep their names out of
    // the LLM contract and strip unsolicited validation metadata before output.
    parameters: createFormTool.parametersSchema.omit({ validation: true }),
    execute: async (params, context) => {
      const schema = context.world.characterSchema;
      const attributes = new Map(
        (schema?.attributes ?? []).map((attribute) => [
          attribute.id,
          attribute,
        ]),
      );
      const isName = (field) =>
        field.name === "characterName" &&
        field.type === "text" &&
        field.required === true;
      // Name every field that cannot stay, so one correction is enough.
      const refused = params.fields
        .filter((field) => !isName(field))
        .map((field) => ({ field, attribute: attributes.get(field.name) }))
        .filter(
          ({ attribute }) =>
            !attribute || !COLLECTABLE_TYPES.includes(attribute.type),
        )
        .map(({ field, attribute }) =>
          attribute
            ? `${field.name} (a ${attribute.type} attribute: it keeps its default)`
            : `${field.name} (not an attribute of this world)`,
        );
      if (refused.length)
        throw new Error(
          `The form cannot collect: ${refused.join(", ")}. ${collectableFields(attributes)}`,
        );
      for (const field of params.fields) {
        if (isName(field)) continue;
        const attribute = attributes.get(field.name);
        if (
          attribute.type === "string" &&
          !["text", "textarea", "select"].includes(field.type)
        ) {
          throw new Error(
            `Field ${field.name} requires a string-valued input.`,
          );
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
      if (!params.fields.some(isName)) {
        throw new Error("Include a required characterName text field.");
      }
      // The setup guard finds this form's submission by this id, so it is set
      // here: the id must not depend on what the model passed.
      return createFormTool.execute(
        { ...params, formId: CHARACTER_FORM_ID },
        context,
      );
    },
  });
}
