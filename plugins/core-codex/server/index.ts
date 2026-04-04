import type { PluginRegistrar } from "@covel/plugin-runtime";
import {
  unlockCodexEntryTool,
  updateCodexEntryTool,
} from "./tools.js";
import { codexContextProvider } from "./context-provider.js";

export default function register(registrar: PluginRegistrar) {
  registrar.addTool("unlock-codex-entry", unlockCodexEntryTool);
  registrar.addTool("update-codex-entry", updateCodexEntryTool);

  registrar.addContextProvider("codex-entries", codexContextProvider);
}
