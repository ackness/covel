import type { PluginRegistrar } from "@covel/plugin-runtime";
import { generateChoicesTool } from "./tools/guide.js";
import { generateActionGuideTool } from "./tools/action-guide.js";
import { guideContextProvider } from "./context/guide-context.js";

export default function register(registrar: PluginRegistrar): void {
  registrar.addTool("generate-choices", generateChoicesTool);
  registrar.addTool("generate-action-guide", generateActionGuideTool);
  registrar.addContextProvider("guide-context", guideContextProvider);
}
