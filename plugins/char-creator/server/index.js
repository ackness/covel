import { createFormTool } from "@covel/tools";
import makeCharacterForm from "../tools/create-character-form.js";
import trackerReadBudget from "../hooks/tracker-read-budget.js";
import protectCharacterProfiles from "../hooks/protect-character-profiles.js";

export default function (covel) {
  covel.registerTool(makeCharacterForm(covel.toolkit, createFormTool));
  covel.on("PreLLMCall", trackerReadBudget);
  covel.on("PreToolUse", protectCharacterProfiles);
}
