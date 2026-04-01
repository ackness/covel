import type { PluginRegistrar } from "@covel/plugin-runtime";
import { personaContextProvider } from "./context/persona-context.js";

export default function register(registrar: PluginRegistrar) {
  registrar.addContextProvider("persona-context", personaContextProvider);

  // The persona runtime is a no-op handler — its actual work is done
  // via the context provider, which injects narrator persona and world
  // context into other runtimes' prompts during context assembly.
  registrar.addRuntimeHandler("persona", async () => ({ proposals: [] }));
}
