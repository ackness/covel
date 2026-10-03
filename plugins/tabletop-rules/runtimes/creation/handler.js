import {
  creationRules,
  validateAllocation,
  translate,
} from "../../lib/rules.js";

export default async function (ctx) {
  const session = await ctx.store.getSession();
  const inSetup = session?.phase === "setup";
  const storedRules = await ctx.pluginData.get("setup", "rules");
  const allocated = await ctx.pluginData.get("setup", "allocated");
  const offered = await ctx.pluginData.get("setup", "offered");
  const player = ctx.world.characters.find(
    (character) => character.type === "player",
  );
  const playerId = player?.id;

  // Derive and freeze the rules as soon as they are available — the
  // world-data provider's same-turn schema output first, then the committed
  // schema. Rules serve later checks independently of the player; the player
  // only gates the form and its application.
  const rules =
    storedRules ??
    creationRules(
      await resolveSchema(ctx),
      await ctx.pluginData.get("rules", "creation"),
      ctx.locale,
    );
  if (!storedRules && rules) await ctx.pluginData.set("setup", "rules", rules);

  const formId = `${ctx.pluginId}-allocation`;
  const submissions = await ctx.store.listPlayerInputs();
  const submitted = submissions.findLast((input) => input.formId === formId);

  if (submitted && allocated?.submissionId !== submitted.id) {
    if (!player) {
      // The submission's player is still riding an uncommitted proposal from
      // an earlier execution; it becomes visible once that turn commits.
      return { outcome: "success", completion: "pending", value: {} };
    }
    if (!rules) throw new Error("Point-buy rules vanished after submission");
    const error = validateAllocation(submitted.values, rules);
    if (error) throw new Error(error);
    const fields = {};
    for (const attribute of rules.attributes) {
      fields[attribute.id] = submitted.values[attribute.id];
    }
    await ctx.tools.call("update-character", { id: player.id, fields });
    await ctx.pluginData.set("setup", "allocated", {
      submissionId: submitted.id,
    });
    return {
      outcome: "success",
      completion: "done",
      value: {
        playerId,
        rules,
        narrativeOutput: translate(ctx, "Opening point allocation applied."),
      },
    };
  }

  if (submitted || allocated) {
    // A retry or restart after the allocation already committed: stay settled
    // without re-applying the patch.
    return {
      outcome: "success",
      completion: "done",
      value: { playerId, ...(rules ? { rules } : {}) },
    };
  }

  if (!playerId) {
    // The character-creation provider has not produced a player yet. While
    // the session is still opening, wait for it instead of competing with its
    // form; once the game is running there is nothing left to allocate onto.
    return inSetup
      ? { outcome: "success", completion: "pending", value: {} }
      : { outcome: "success", completion: "done", value: {} };
  }

  if (!rules) {
    // The world configured no rules and exposes no allocatable attributes:
    // allocation is unavailable, so settle silently without blocking setup or
    // the check runtime.
    return {
      outcome: "success",
      completion: "done",
      value: { playerId },
    };
  }

  if (!inSetup) {
    // Late enable (or re-enable after an earlier allocation): initialize the
    // rules for checks without re-asking the player.
    return {
      outcome: "success",
      completion: "done",
      value: { playerId, rules },
    };
  }

  if (offered) {
    // The allocation form is already pending; keep waiting for the player
    // instead of emitting a duplicate form every turn.
    return { outcome: "success", completion: "pending", value: {} };
  }

  // Opening flow: the identity/personality form already created the player;
  // offer the allocation form on top of those fields. Rules freeze at first
  // display so later configuration changes cannot alter a shown form.
  const result = await ctx.tools.call("create-form", {
    formId,
    title: translate(
      ctx,
      "Opening point allocation: distribute {budget} points",
      { budget: rules.budget },
    ),
    fields: rules.attributes.map((attribute) => ({
      type: "number",
      name: attribute.id,
      label: attribute.label,
      min: attribute.base,
      max: attribute.max,
      step: 1,
      defaultValue: attribute.base,
      required: true,
    })),
    validation: { name: "point-buy", data: rules },
    submitLabel: translate(ctx, "Finish allocation"),
    narrativeTemplate: translate(ctx, "Opening point allocation complete."),
  });
  await ctx.pluginData.set("setup", "offered", { formId });
  return {
    outcome: "success",
    completion: "pending",
    value: { playerId, rules },
    effects: { interactions: [result.interaction] },
  };
}

/** Read the execution view, including the schema generated upstream. */
async function resolveSchema(ctx) {
  return ctx.world.characterSchema;
}
