import type { PluginRegistrar } from "@covel/plugin-runtime";
import { personaContextProvider } from "./context/persona-context.js";

export default function register(registrar: PluginRegistrar) {
  registrar.addContextProvider("persona-context", personaContextProvider);
}
