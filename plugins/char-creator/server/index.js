import { createFormTool } from "@covel/tools";
import makeCharacterForm from "../tools/create-character-form.js";

export default function (covel) {
  covel.registerTool(makeCharacterForm(covel.toolkit, createFormTool));
}
