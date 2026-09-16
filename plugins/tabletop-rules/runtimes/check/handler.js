import { randomInt } from "node:crypto";
import { pickLocaleText } from "../../lib/rules.js";

export default async function (ctx) {
  const { characters } = await ctx.tools.call("list-characters", {
    type: "player",
  });
  const player = characters[0];
  if (!player) throw new Error("Create a player character before rolling");
  const rules = await ctx.pluginData.get("setup", "rules");
  if (!rules?.attributes?.length)
    throw new Error("Point-buy rules are unavailable");
  if (ctx.manualPayload?.openForm === true) return openForm(ctx, rules);
  const sourceTurn = ctx.execution?.sourceTurnId ?? ctx.turnId;
  const previous = await ctx.pluginData.get("turn-checks", sourceTurn);
  if (previous) return settled(previous);
  const submissions = await ctx.store.listPlayerInputs(ctx.sessionId);
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
      const modifier = player.fields?.[attribute];
      if (!Number.isSafeInteger(modifier))
        throw new Error("The selected attribute is not numeric");
      const die = randomInt(1, 21);
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
  return settled(receipt);
}

function settled(receipt) {
  return {
    outcome: "success",
    value: {
      receipt: receipt ?? null,
      checkContext: receipt
        ? `Settled tabletop check (do not reroll or change the result): ${JSON.stringify(receipt)}`
        : "No tabletop check submitted. Do not invent a roll.",
    },
  };
}

async function openForm(ctx, rules) {
  const zh = pickLocaleText(ctx.locale, true, false);
  const form = await ctx.tools.call("create-form", {
    formId: `${ctx.pluginId}-check-${ctx.turnId}`,
    title: zh ? "属性检定" : "Attribute check",
    fields: [
      {
        type: "text",
        name: "action",
        label: zh ? "尝试的行动" : "Attempted action",
        required: true,
      },
      {
        type: "select",
        name: "attribute",
        label: zh ? "属性" : "Attribute",
        required: true,
        options: rules.attributes.map((attribute) => ({
          value: attribute.id,
          label: attribute.label,
        })),
      },
      {
        type: "select",
        name: "difficulty",
        label: zh ? "难度" : "Difficulty",
        required: true,
        defaultValue: "12",
        options: ["8", "12", "16", "20"],
      },
    ],
    submitLabel: zh ? "进行检定" : "Resolve check",
    narrativeTemplate: "{{action}} ({{attribute}}, DC {{difficulty}}).",
  });
  return {
    outcome: "success",
    value: {},
    effects: { interactions: [form.interaction] },
  };
}
