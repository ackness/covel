import {
  creationRules,
  validateAllocation,
  pickLocaleText,
} from "../../lib/rules.js";

export default async function (ctx) {
  // Pass the session id explicitly: builtin installs receive the full
  // DataStore (getSession(id)), community installs the session-bound
  // FunctionStoreView (getSession()) — the argument is accepted by both.
  const session = await ctx.store.getSession(ctx.sessionId);
  const inSetup = session?.phase === "setup";
  const storedRules = await ctx.pluginData.get("setup", "rules");
  const allocated = await ctx.pluginData.get("setup", "allocated");
  const offered = await ctx.pluginData.get("setup", "offered");
  const { characters } = await ctx.tools.call("list-characters", {
    type: "player",
  });
  const player = characters[0];
  // The character-creation provider's same-turn output: its guard may have
  // just buffered the player as a proposal, which list-characters cannot see
  // until the turn commits, so the id travels through the runtime output.
  const createdThisTurn = ctx.inputs?.playerId?.value;
  const playerId =
    player?.id ??
    (typeof createdThisTurn === "string" ? createdThisTurn : undefined);

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
  const submissions = await ctx.store.listPlayerInputs(ctx.sessionId);
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
        narrativeOutput: pickLocaleText(
          ctx.locale,
          "开局配点已应用。",
          "Opening point allocation applied.",
        ),
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
  const zh = pickLocaleText(ctx.locale, true, false);
  const result = await ctx.tools.call("create-form", {
    formId,
    title: zh
      ? `开局配点：分配 ${rules.budget} 点`
      : `Opening point allocation: distribute ${rules.budget} points`,
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
    submitLabel: zh ? "完成配点" : "Finish allocation",
    narrativeTemplate: zh
      ? "完成了开局配点。"
      : "Opening point allocation complete.",
  });
  await ctx.pluginData.set("setup", "offered", { formId });
  return {
    outcome: "success",
    completion: "pending",
    value: { playerId, rules },
    effects: { interactions: [result.interaction] },
  };
}

/**
 * Resolve the world character-attributes schema for rule derivation: the
 * same-turn world-data-provider output first, then the committed schema via
 * the public read tool (producers that already finished do not re-run).
 */
async function resolveSchema(ctx) {
  const schemaValue =
    ctx.inputs?.schema?.value ??
    (await ctx.tools.call("get-character-schema", {})).schema;
  // World providers publish a schema map; the read tool returns one schema.
  return schemaValue?.["character-attributes"] ?? schemaValue;
}
