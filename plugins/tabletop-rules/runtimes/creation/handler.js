import {
  creationRules,
  validateAllocation,
  pickLocaleText,
} from "../../lib/rules.js";

export default async function (ctx) {
  const { characters } = await ctx.tools.call("list-characters", {
    type: "player",
  });
  const storedRules = await ctx.pluginData.get("setup", "rules");
  // Input bindings only cover this execution; a resumed setup may have already
  // committed its world schema in an earlier turn.
  const schemaValue = storedRules
    ? undefined
    : (ctx.inputs?.schema?.value ??
      (await ctx.tools.call("get-character-schema", {})).schema);
  // World providers publish a schema map; the read tool returns one schema.
  const schema = schemaValue?.["character-attributes"] ?? schemaValue;
  if (characters.length) {
    const rules =
      storedRules ??
      creationRules(
        schema,
        await ctx.pluginData.get("rules", "creation"),
        ctx.locale,
      );
    if (!storedRules) await ctx.pluginData.set("setup", "rules", rules);
    return {
      outcome: "success",
      completion: "done",
      value: { playerId: characters[0].id, rules },
    };
  }
  const formId = `${ctx.pluginId}-character`;
  const submissions = await ctx.store.listPlayerInputs(ctx.sessionId);
  const submitted = submissions.findLast((input) => input.formId === formId);
  if (submitted) {
    const error = validateAllocation(submitted.values, storedRules);
    if (error) throw new Error(error);
    const { characterName, ...fields } = submitted.values;
    const result = await ctx.tools.call("create-character", {
      name: characterName.trim(),
      type: "player",
      fields,
    });
    await ctx.pluginData.set("setup", "created", {
      submissionId: submitted.id,
      characterId: result.characterId,
    });
    return {
      outcome: "success",
      completion: "done",
      value: {
        playerId: result.characterId,
        rules: storedRules,
        narrativeOutput: pickLocaleText(
          ctx.locale,
          `角色 ${characterName.trim()} 已创建。`,
          `Character ${characterName.trim()} created.`,
        ),
      },
    };
  }
  const rules =
    storedRules ??
    creationRules(
      schema,
      await ctx.pluginData.get("rules", "creation"),
      ctx.locale,
    );
  await ctx.pluginData.set("setup", "rules", rules);
  const zh = pickLocaleText(ctx.locale, true, false);
  const result = await ctx.tools.call("create-form", {
    formId,
    title: zh
      ? `配点创角：分配 ${rules.budget} 点`
      : `Character creation: allocate ${rules.budget} points`,
    fields: [
      {
        type: "text",
        name: "characterName",
        label: zh ? "角色名" : "Character name",
        required: true,
      },
      ...rules.attributes.map((attribute) => ({
        type: "number",
        name: attribute.id,
        label: attribute.label,
        min: attribute.base,
        max: attribute.max,
        step: 1,
        defaultValue: attribute.base,
        required: true,
      })),
    ],
    validation: { name: "point-buy", data: rules },
    submitLabel: zh ? "创建角色" : "Create character",
    narrativeTemplate: zh
      ? "{{characterName}} 的冒险即将开始。"
      : "{{characterName}} is ready for adventure.",
  });
  return {
    outcome: "success",
    completion: "pending",
    effects: { interactions: [result.interaction] },
  };
}
