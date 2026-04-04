import type { PluginRegistrar } from "@covel/plugin-runtime";
import { requestStoryImageTool } from "./tools.js";
import { imageRuntimeHandler } from "./runtime-handler.js";
import { imageContextProvider } from "./context-provider.js";

export default function register(registrar: PluginRegistrar) {
  registrar.addTool("request-story-image", requestStoryImageTool);
  registrar.addRuntimeHandler("image-generator", imageRuntimeHandler);
  registrar.addContextProvider("image-history", imageContextProvider);
}
