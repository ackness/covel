import { applyPlans } from "../../lib/plan.js";

const HIDDEN_EVENTS = "_hidden.events";
// Planned events get their own hidden bucket so a world-data resync of the
// authored events never touches them.
const PLANNED = "_hidden.planned";
const REVEALED = "revealed";

async function byKey(ctx, namespace) {
  return Object.fromEntries(
    (await ctx.pluginData.list(namespace)).map((row) => [row.key, row.value]),
  );
}

function numericFields(value) {
  if (!value || typeof value !== "object") return null;
  return new Set(
    Object.keys(value).filter((key) => typeof value[key] === "number"),
  );
}

export default async function handler(ctx) {
  const plans = ctx.inputs?.plans?.items ?? [];
  if (!plans.length)
    return {
      outcome: "success",
      value: { accepted: [], retired: [], rejected: [] },
    };

  const dimensions = ctx.inputs?.dimensions?.value ?? ctx.world?.dimensions;
  const { writes, accepted, retired, rejected } = applyPlans({
    plans,
    authored: await byKey(ctx, HIDDEN_EVENTS),
    planned: await byKey(ctx, PLANNED),
    revealed: await byKey(ctx, REVEALED),
    dimensions: dimensions ? new Set(Object.keys(dimensions)) : null,
    timeFields: numericFields(ctx.inputs?.worldTime?.value),
    turn: ctx.logicalTurn ?? 1,
  });
  for (const write of writes)
    await ctx.pluginData.set(PLANNED, write.key, write.value);
  return { outcome: "success", value: { accepted, retired, rejected } };
}
