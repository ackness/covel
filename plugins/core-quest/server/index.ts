import type { PluginRegistrar } from "@covel/plugin-runtime";
import {
  createQuestTool,
  updateQuestTool,
  completeObjectiveTool,
  completeQuestTool,
  failQuestTool,
} from "./tools.js";
import { questContextProvider } from "./context-provider.js";

export default function register(registrar: PluginRegistrar) {
  registrar.addTool("create-quest", createQuestTool);
  registrar.addTool("update-quest", updateQuestTool);
  registrar.addTool("complete-objective", completeObjectiveTool);
  registrar.addTool("complete-quest", completeQuestTool);
  registrar.addTool("fail-quest", failQuestTool);

  registrar.addContextProvider("quest-status", questContextProvider);
}
