import type { PluginRegistrar } from "@covel/plugin-runtime";
import { updateLocationTool, advanceTimeTool, setWeatherTool } from "./tools.js";
import { worldStateContextProvider } from "./context-provider.js";

export default function register(registrar: PluginRegistrar): void {
  // Tools — LLM calls these during the world-state-tracker runtime
  registrar.addTool("update-location", updateLocationTool);
  registrar.addTool("advance-time", advanceTimeTool);
  registrar.addTool("set-weather", setWeatherTool);

  // Context provider — injects world state summary into other runtimes
  registrar.addContextProvider("world-state-context", worldStateContextProvider);
}
