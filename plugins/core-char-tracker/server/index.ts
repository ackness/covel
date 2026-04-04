import type { PluginRegistrar } from "@covel/plugin-runtime";
import { upsertCharacterTool } from "./tools.js";

export default function register(registrar: PluginRegistrar): void {
  registrar.addTool("upsert-character", upsertCharacterTool);
}
