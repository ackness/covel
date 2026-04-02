import type { PluginRegistrar } from "@covel/plugin-runtime";
import { narratorContextProvider } from "./context-provider.js";

/**
 * core-narrator plugin registration.
 *
 * The narrator is a "story" kind runtime that uses the LLM path directly.
 * PLUGIN.md serves as the LLM instructions — no runtimeHandler is needed.
 * This module only registers a context provider so downstream runtimes
 * (guide, tracker, etc.) can see narrative guidance and latest output.
 */
export default function register(registrar: PluginRegistrar): void {
  registrar.addContextProvider("narrator-context", narratorContextProvider);
}
