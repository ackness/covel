import type { PluginRegistrar } from "@covel/plugin-runtime";
import {
  startCombatTool,
  attackTool,
  defendTool,
  useSkillTool,
  endCombatTool,
} from "./tools.js";
import { combatContextProvider } from "./context-provider.js";

export default function register(registrar: PluginRegistrar): void {
  // Tools — NO runtimeHandler (uses LLM path via PLUGIN.md)
  registrar.addTool("start-combat", startCombatTool);
  registrar.addTool("attack", attackTool);
  registrar.addTool("defend", defendTool);
  registrar.addTool("use-skill", useSkillTool);
  registrar.addTool("end-combat", endCombatTool);

  // Context provider — injects combat status when active
  registrar.addContextProvider("combat-status", combatContextProvider);
}
