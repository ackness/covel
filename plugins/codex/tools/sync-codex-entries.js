import {
  getPendingProposals,
  getToolContent,
  withPendingProposals,
} from "@covel/tools";
import makeUnlockCodexEntries, {
  createCodexEntrySchema,
} from "./unlock-codex-entries.js";
import makeUpdateCodexEntry, {
  createCodexUpdateSchema,
} from "./update-codex-entry.js";

export default function (toolkit) {
  const { tool, z } = toolkit;
  const unlockCodexEntries = makeUnlockCodexEntries(toolkit);
  const updateCodexEntry = makeUpdateCodexEntry(toolkit);

  return tool({
    name: "sync-codex-entries",
    description:
      "Atomically submit every codex change found in this turn. Put new discoveries in unlocks and additions to existing records in updates. Call once at most; use runtime-done instead when neither array has changes.",
    parameters: z
      .object({
        unlocks: z
          .array(createCodexEntrySchema(z))
          .max(3)
          .default([])
          .describe("Up to 3 genuinely new codex entries."),
        updates: z
          .array(createCodexUpdateSchema(z))
          .max(5)
          .default([])
          .describe("Additions to existing entries, identified by entryId."),
      })
      .refine((value) => value.unlocks.length + value.updates.length > 0, {
        message:
          "submit at least one unlock or update; use runtime-done when nothing changed",
      }),
    execute: async ({ unlocks, updates }, context) => {
      const proposals = [];
      const ui = [];
      const unlockedEntries = [];
      const updatedEntries = [];

      if (unlocks.length > 0) {
        const rawUnlock = await unlockCodexEntries.execute(
          { entries: unlocks },
          context,
        );
        proposals.push(...getPendingProposals(rawUnlock));
        const unlockOutput = getToolContent(rawUnlock);
        unlockedEntries.push(...(unlockOutput.entries ?? []));
        ui.push(...(unlockOutput.ui ?? []));
      }

      for (const update of updates) {
        const rawUpdate = await updateCodexEntry.execute(update, {
          ...context,
          pendingProposals: [...(context.pendingProposals ?? []), ...proposals],
        });
        const updateOutput = getToolContent(rawUpdate);
        if (updateOutput.updated !== true) {
          throw new Error(
            updateOutput.error ??
              `Entry ${update.entryId} could not be updated`,
          );
        }
        proposals.push(...getPendingProposals(rawUpdate));
        updatedEntries.push({
          entryId: updateOutput.entryId,
          appendedContent: updateOutput.appendedContent,
        });
        ui.push(...(updateOutput.ui ?? []));
      }

      return withPendingProposals(
        {
          unlocked: unlockedEntries.length,
          updated: updatedEntries.length,
          entries: unlockedEntries,
          updates: updatedEntries,
          ui,
        },
        proposals,
      );
    },
  });
}
