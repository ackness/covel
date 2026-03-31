import type { PluginRegistrar } from "@covel/plugin-runtime";
import { generateChoicesTool } from "./tools/guide.js";
import { guideContextProvider } from "./context/guide-context.js";

export default function register(registrar: PluginRegistrar) {
  registrar.addTool("generate-choices", generateChoicesTool);
  registrar.addContextProvider("guide-context", guideContextProvider);
}
