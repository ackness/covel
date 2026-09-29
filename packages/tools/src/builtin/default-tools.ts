/** Built-in tool set shared by the server and isolated runtime runner. */

import { ToolRegistry } from "../registry.js";
import { createCharacterTools } from "./character-tools.js";
import { createEmitEventTool, type EventDirectoryLike } from "./emit-event.js";
import { createPluginDataTools } from "./plugin-data-tools.js";
import { runtimeDoneTool } from "./runtime-done.js";
import { suspendTool } from "./suspend.js";
import { builtinUITools } from "./ui-tools.js";

type DefaultToolStore = Parameters<typeof createPluginDataTools>[0] &
  Parameters<typeof createCharacterTools>[0];

export interface DefaultToolRegistryDeps {
  readonly store: DefaultToolStore;
  readonly eventDirectory: EventDirectoryLike;
}

/** Register the standard built-ins once, with host-specific stores and events. */
export function createDefaultToolRegistry(
  deps: DefaultToolRegistryDeps,
): ToolRegistry {
  const registry = new ToolRegistry();
  for (const module of builtinUITools) registry.registerBuiltin(module);
  registry.registerBuiltin(suspendTool);
  registry.registerBuiltin(runtimeDoneTool);
  for (const module of createPluginDataTools(deps.store)) {
    registry.registerBuiltin(module);
  }
  registry.registerBuiltin(
    createEmitEventTool({ directory: deps.eventDirectory }),
  );
  for (const module of createCharacterTools(deps.store)) {
    registry.registerBuiltin(module);
  }
  return registry;
}
