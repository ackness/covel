import {
  getPendingProposals,
  getToolContent,
  shortIdBatch,
  withPendingProposals,
} from "@covel/plugin-handlers-utils";
import { z } from "zod";

import createUpsertQuests from "../../lib/upsert-quests.js";
import { questUpdatesFromWorldIR } from "../../lib/world-ir.js";

const upsertQuests = createUpsertQuests({
  tool: (definition) => definition,
  z,
  shortIdBatch,
});

/**
 * Register and advance quests from the shared WorldIR extraction, without a
 * model call.
 *
 * @type {import("@covel/plugin-handlers-utils").PluginFunctionHandler}
 */
export default async function handler(ctx) {
  const rows = (await ctx.store.listPluginData("quests")) ?? [];
  const known = rows
    .map((row) => row.value?.name)
    .filter((name) => typeof name === "string" && name.trim());
  const quests = questUpdatesFromWorldIR(ctx.inputs?.worldIR?.value, known);
  if (!quests.length)
    return {
      outcome: "success",
      value: { upserted: 0, created: 0, advanced: 0, quests: [] },
    };
  const result = await upsertQuests.execute(
    upsertQuests.parameters.parse({ quests }),
    ctx,
  );
  return withPendingProposals(
    { outcome: "success", value: getToolContent(result) },
    getPendingProposals(result),
  );
}
