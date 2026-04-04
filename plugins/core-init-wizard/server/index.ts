import type { PluginRegistrar } from "@covel/plugin-runtime";
import { emitCharacterFormTool } from "./tools.js";

export default function register(registrar: PluginRegistrar) {
  registrar.addTool("emit-character-form", emitCharacterFormTool);
}
