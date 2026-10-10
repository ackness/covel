import { checkModifier, pickLocaleText, translate } from "../../lib/rules.js";

export default async function (ctx) {
  const rules =
    ctx.inputs?.rules?.value ?? (await ctx.pluginData.get("setup", "rules"));
  if (!rules?.attributes?.length) {
    // The world has no point-buy rules (allocation was skipped): stay inert
    // instead of failing every turn.
    if (ctx.manualPayload?.openForm === true) {
      throw new Error(
        translate(
          ctx,
          "This world has no point-buy attributes; checks are unavailable.",
        ),
      );
    }
    return {
      outcome: "success",
      value: { receipt: null },
    };
  }
  const { characters } = await ctx.tools.call("list-characters", {
    type: "player",
  });
  const player = characters[0];
  if (!player) throw new Error("Create a player character before rolling");
  if (ctx.manualPayload?.openForm === true) return openForm(ctx, rules);
  const sourceTurn = ctx.execution?.sourceTurnId ?? ctx.turnId;
  const previous = await ctx.pluginData.get("turn-checks", sourceTurn);
  if (previous) return settled(previous, ctx.locale);
  const submissions = await ctx.store.listPlayerInputs();
  const submitted = submissions.findLast((input) =>
    input.formId.startsWith(`${ctx.pluginId}-check-`),
  );
  let receipt;
  if (submitted) {
    const saved = await ctx.pluginData.get("checks", submitted.id);
    if (saved?.resolvedTurnId === sourceTurn) receipt = saved;
    if (!saved) {
      const { attribute, difficulty, action } = submitted.values;
      if (typeof action !== "string" || !action.trim())
        throw new Error("Describe the attempted action");
      const rule = rules.attributes.find((item) => item.id === attribute);
      const dc = Number(difficulty);
      if (!rule || ![8, 12, 16, 20].includes(dc))
        throw new Error("Invalid check request");
      const score = player.fields?.[attribute];
      if (!Number.isSafeInteger(score))
        throw new Error("The selected attribute is not numeric");
      const modifier = checkModifier(
        score,
        ctx.world?.characterSchema?.attributes?.find(
          (declared) => declared.id === attribute,
        ),
      );
      const die = ctx.random.int(1, 21);
      // The same critical rules as `dice-check/lib/check-rules.js`; keep them in step.
      const outcome =
        die === 20
          ? "critical-success"
          : die === 1
            ? "critical-failure"
            : die + modifier >= dc
              ? "success"
              : "failure";
      receipt = {
        submissionId: submitted.id,
        action: action.trim(),
        resolvedTurnId: sourceTurn,
        characterId: player.id,
        attribute,
        score,
        modifier,
        die,
        difficulty: dc,
        total: die + modifier,
        outcome,
      };
      await ctx.pluginData.set("checks", submitted.id, receipt);
      await ctx.pluginData.set("turn-checks", sourceTurn, receipt);
    }
  }
  return settled(receipt, ctx.locale);
}

/**
 * What the narrative reads. `Settled tabletop check` is a marker that the
 * narrative prompts name in both languages; the rest is an instruction.
 */
function settled(receipt, locale) {
  // The model reads the check, not the rows it is stored under.
  const {
    submissionId: _submission,
    resolvedTurnId: _turn,
    ...check
  } = receipt ?? {};
  return {
    outcome: "success",
    value: {
      receipt: receipt ?? null,
      checkContext: receipt
        ? pickLocaleText(
            locale,
            `Settled tabletop check（不要重掷，也不要改动结果）：${JSON.stringify(check)}`,
            `Settled tabletop check (do not reroll or change the result): ${JSON.stringify(check)}`,
          )
        : pickLocaleText(
            locale,
            "没有提交跑团检定。不要编造掷骰。",
            "No tabletop check submitted. Do not invent a roll.",
          ),
    },
  };
}

async function openForm(ctx, rules) {
  const form = await ctx.tools.call("create-form", {
    formId: `${ctx.pluginId}-check-${ctx.turnId}`,
    title: translate(ctx, "Attribute check"),
    fields: [
      {
        type: "text",
        name: "action",
        label: translate(ctx, "Attempted action"),
        required: true,
      },
      {
        type: "select",
        name: "attribute",
        label: translate(ctx, "Attribute"),
        required: true,
        options: rules.attributes.map((attribute) => ({
          value: attribute.id,
          label: attribute.label,
        })),
      },
      {
        type: "select",
        name: "difficulty",
        label: translate(ctx, "Difficulty"),
        required: true,
        defaultValue: "12",
        options: ["8", "12", "16", "20"],
      },
    ],
    submitLabel: translate(ctx, "Resolve check"),
    narrativeTemplate: "{{action}} ({{attribute}}, DC {{difficulty}}).",
  });
  return {
    outcome: "success",
    value: {},
    effects: { interactions: [form.interaction] },
  };
}
