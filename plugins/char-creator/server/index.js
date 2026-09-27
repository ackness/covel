import { createFormTool } from "@covel/tools";
import makeCharacterForm from "../tools/create-character-form.js";
import trackerReadBudget from "../hooks/tracker-read-budget.js";
import protectCharacterProfiles from "../hooks/protect-character-profiles.js";

export default function (covel) {
  covel.provideExtension("prompt.segment@1", "character-roster", {
    handler(_input, ctx) {
      return [
        {
          id: "character-roster",
          content: `<existing-characters>\n${JSON.stringify(ctx.world.characters.map(({ id, name, type, version, description }) => ({ id, name, type, version, description })))}\n</existing-characters>`,
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
