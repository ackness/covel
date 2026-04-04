import type { PluginRegistrar } from "@covel/plugin-runtime";
import {
  createEventTool,
  evolveEventTool,
  resolveEventTool,
  endEventTool,
} from "./tools.js";
import { eventContextProvider } from "./context-provider.js";

export default function register(registrar: PluginRegistrar) {
  registrar.addTool("create-event", createEventTool);
  registrar.addTool("evolve-event", evolveEventTool);
  registrar.addTool("resolve-event", resolveEventTool);
  registrar.addTool("end-event", endEventTool);

  registrar.addContextProvider("event-timeline", eventContextProvider);
}
