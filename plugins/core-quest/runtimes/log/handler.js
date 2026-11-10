import {
  getPendingProposals,
  getToolContent,
  withPendingProposals,
} from "@covel/plugin-handlers-utils";

import upsertQuests from "../../lib/upsert-quests.js";
import { MAX_QUESTS, questUpdatesFromWorldIR } from "../../lib/world-ir.js";

/**
 * Register and advance quests from the shared WorldIR extraction, without a
 * model call. The extraction is optional: without it (no provider in the
 * session, or it failed this turn) the log changes nothing, and quests that
 * the world seeded stay as they are.
 *
 * @type {import("@covel/plugin-handlers-utils").PluginFunctionHandler}
 */
export default async function handler(ctx) {
  if (!ctx.inputs?.worldIR)
    return {
      outcome: "skipped",
      skipReason: "No world facts this turn; quests are not updated",
    };
  const rows = (await ctx.store.listPluginData("quests")) ?? [];
  const known = rows
    .map((row) => row.value?.name)
    .filter((name) => typeof name === "string" && name.trim());
  const all = questUpdatesFromWorldIR(ctx.inputs?.worldIR?.value, known);
  const quests = all.slice(0, MAX_QUESTS);
  const notRecorded = all.length - quests.length;
  if (!quests.length)
    return {
      outcome: "success",
      value: { upserted: 0, created: 0, advanced: 0, quests: [] },
    };
  const result = await upsertQuests({ quests }, ctx);
  return withPendingProposals(
    {
      outcome: "success",
      value: {
        ...getToolContent(result),
        ...(notRecorded > 0 && {
          notRecorded,
          note: `${notRecorded} quest update(s) were not recorded: a turn records at most ${MAX_QUESTS}.`,
        }),
      },
    },
    getPendingProposals(result),
  );
}
