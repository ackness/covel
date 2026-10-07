import { createFormTool } from "@covel/plugin-handlers-utils";
import makeCharacterForm from "../tools/create-character-form.js";
import trackerReadBudget from "../hooks/tracker-read-budget.js";
import protectCharacterProfiles from "../hooks/protect-character-profiles.js";

/** Characters of current field values carried in the roster. */
const ROSTER_FIELDS_BUDGET = 12000;

/**
 * Roster with each character's current fields while they fit, so the tracker
 * can settle changes without a get-character round trip. Characters past the
 * budget are marked `fieldsOmitted` and read on demand.
 */
function rosterRows(characters) {
  let used = 0;
  // No record version: the tracker passes none, and it changes with every
  // update of a character.
  return characters.map(({ id, name, type, description, fields }) => {
    const row = { id, name, type, description };
    const size = JSON.stringify(fields ?? {}).length;
    if (used + size > ROSTER_FIELDS_BUDGET)
      return { ...row, fieldsOmitted: true };
    used += size;
    return { ...row, fields: fields ?? {} };
  });
}

export default function (covel) {
  covel.provideExtension("prompt.segment@1", "character-roster", {
    handler(_input, ctx) {
      return [
        {
          id: "character-roster",
          content: `<existing-characters>\n${JSON.stringify(rosterRows(ctx.world.characters))}\n</existing-characters>`,
          position: "pre-history",
          audience: "self",
          volatility: "turn",
        },
      ];
    },
  });
  covel.registerTool(makeCharacterForm(covel.toolkit, createFormTool));
  covel.on("PreLLMCall", trackerReadBudget);
  covel.on("PreToolUse", protectCharacterProfiles);
}
