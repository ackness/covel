import { createFormTool } from "@covel/plugin-handlers-utils";
import makeCharacterForm from "../tools/create-character-form.js";
import trackerReadBudget from "../hooks/tracker-read-budget.js";
import protectCharacterProfiles from "../hooks/protect-character-profiles.js";

/** Characters of current field values carried in the roster. */
const ROSTER_FIELDS_BUDGET = 12000;

/**
 * Who is in the session: id, name, type and description. These hold until a
 * character is created or rewritten. No record version: the tracker passes
 * none, and it changes with every update of a character.
 */
function rosterRows(characters) {
  return characters.map(({ id, name, type, description }) => ({
    id,
    name,
    type,
    description,
  }));
}

/**
 * Each character's current fields while they fit, one line per id, so the
 * tracker can settle changes without a get-character round trip. Characters
 * past the budget are marked `fieldsOmitted` and read on demand.
 */
function fieldLines(characters) {
  let used = 0;
  return characters.map(({ id, fields }) => {
    const json = JSON.stringify(fields ?? {});
    if (used + json.length > ROSTER_FIELDS_BUDGET)
      return `${id}: fieldsOmitted`;
    used += json.length;
    return `${id}: ${json}`;
  });
}

export default function (covel) {
  covel.provideExtension("prompt.segment@1", "character-roster", {
    handler(_input, ctx) {
      // Two segments, the one that changes least first. A number on one sheet
      // changes on many turns; were it inside the roster, the request would
      // stop repeating the previous turn's at that character, and a
      // provider's prompt cache serves a request only that far.
      return [
        {
          id: "character-roster",
          content: `<existing-characters>\n${JSON.stringify(rosterRows(ctx.world.characters))}\n</existing-characters>`,
          position: "pre-history",
          audience: "self",
          volatility: "session",
        },
        {
          id: "character-fields",
          content: `<character-fields>\n${fieldLines(ctx.world.characters).join("\n")}\n</character-fields>`,
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
