import type { PluginRegistrar } from "@covel/plugin-runtime";
import { rollCheckTool, rollDiceTool } from "./tools.js";
import { diceContextProvider } from "./context-provider.js";

export default function register(registrar: PluginRegistrar): void {
  registrar.addTool("roll-check", rollCheckTool);
  registrar.addTool("roll-dice", rollDiceTool);
  registrar.addContextProvider("dice-context", diceContextProvider);
}
