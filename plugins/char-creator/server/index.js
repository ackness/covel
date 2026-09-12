import { createFormTool } from "@covel/tools";
import makeCharacterForm from "../tools/create-character-form.js";
import trackerReadBudget from "../hooks/tracker-read-budget.js";

export default function (covel) {
  covel.registerTool(makeCharacterForm(covel.toolkit, createFormTool));
  covel.on("PreLLMCall", trackerReadBudget);
}
