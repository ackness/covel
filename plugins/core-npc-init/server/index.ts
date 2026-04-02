import type { PluginRegistrar } from "@covel/plugin-runtime";
import {
  defineCharacterSchemaTool,
  createNpcTool,
  finalizeInitTool,
} from "./tools.js";

export default function register(registrar: PluginRegistrar) {
  registrar.addTool("define-character-schema", defineCharacterSchemaTool);
  registrar.addTool("create-npc", createNpcTool);
  registrar.addTool("finalize-init", finalizeInitTool);
}
