import { createFormTool, estimateTokens } from "@covel/plugin-handlers-utils";
import makeCharacterForm from "../tools/create-character-form.js";
import trackerReadBudget from "../hooks/tracker-read-budget.js";
import protectCharacterProfiles from "../hooks/protect-character-profiles.js";
import {
  PLAYER_NAME_VALIDATOR,
  validatePlayerName,
} from "../lib/player-name.js";

/** Characters of current field values carried in the roster. */
const ROSTER_FIELDS_BUDGET = 12000;

// The roster is sent with every tracker call. 6000 estimated tokens hold the
// full rows of some twenty-five characters with a 200-character Chinese
// paragraph each (sixty with an English one); a budget in
// characters would give a Chinese world three times the room.
export const ROSTER_TOKEN_BUDGET = 6000;
/**
 * How much of each description is written: all of it, its first sentence or
 * two, or none. The first level that fits the budget is used for every row,
 * so one row does not depend on which description is longest. The id, name,
 * aliases and type are never dropped: they are what stops the tracker from
 * creating a known person again.
 */
const DESCRIPTION_CAPS = [Infinity, 120, 0];

/**
 * Who is in the session: id, name, aliases (when there are any), type and
 * description. These hold until a character is created or rewritten. No
 * record version: the tracker passes none, and it changes with every update
 * of a character.
 */
function rosterRows(characters, descriptionCap) {
  return characters.map(({ id, name, aliases, type, description }) => {
    const text = description ?? "";
    return {
      id,
      name,
      ...(aliases?.length ? { aliases } : {}),
      type,
      ...(descriptionCap === 0
        ? {}
        : {
            description:
              text.length > descriptionCap
                ? `${text.slice(0, descriptionCap)}...`
                : text,
          }),
    };
  });
}

/** The roster as JSON at the first level of detail that fits the budget. */
function rosterJson(characters) {
  let json = "[]";
  for (const cap of DESCRIPTION_CAPS) {
    json = JSON.stringify(rosterRows(characters, cap));
    if (estimateTokens(json) <= ROSTER_TOKEN_BUDGET) break;
  }
  return json;
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
          content: `<existing-characters>\n${rosterJson(ctx.world.characters)}\n</existing-characters>`,
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
  covel.registerFormValidator(PLAYER_NAME_VALIDATOR, validatePlayerName);
  covel.on("PreLLMCall", trackerReadBudget);
  covel.on("PreToolUse", protectCharacterProfiles);
}
