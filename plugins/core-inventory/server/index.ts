import type { PluginRegistrar } from "@covel/plugin-runtime";
import {
  addItemTool,
  removeItemTool,
  useItemTool,
  equipItemTool,
  modifyCurrencyTool,
} from "./tools.js";
import { inventoryContextProvider } from "./context-provider.js";

export default function register(registrar: PluginRegistrar) {
  // Tools — the LLM calls these via the inventory-tracker runtime
  registrar.addTool("add-item", addItemTool);
  registrar.addTool("remove-item", removeItemTool);
  registrar.addTool("use-item", useItemTool);
  registrar.addTool("equip-item", equipItemTool);
  registrar.addTool("modify-currency", modifyCurrencyTool);

  // Context provider — injects inventory summary into other runtimes
  registrar.addContextProvider("inventory-context", inventoryContextProvider);

  // No runtime handler registered — uses LLM path with tools (PLUGIN.md as instructions)
}
