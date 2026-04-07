import type { PluginRegistrar } from "@covel/plugin-runtime";
import { imageRuntimeHandler, settingsUpdaterHandler } from "./runtime-handler.js";
import { imageContextProvider } from "./context-provider.js";

export default function register(registrar: PluginRegistrar) {
  registrar.addRuntimeHandler("image-generator", imageRuntimeHandler);
  registrar.addRuntimeHandler("settings-updater", settingsUpdaterHandler);
  registrar.addContextProvider("image-history", imageContextProvider);
}
