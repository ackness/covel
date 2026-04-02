import type { PluginRegistrar } from "@covel/plugin-runtime";
import { charTrackerHandler } from "./handler.js";

export default function register(registrar: PluginRegistrar): void {
  registrar.addRuntimeHandler("char-tracker", charTrackerHandler);
}
