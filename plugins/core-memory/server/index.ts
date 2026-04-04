import type { PluginRegistrar } from "@covel/plugin-runtime";
import type {
  ContextProvider,
  ContextProviderInput,
} from "@covel/plugin-runtime";
import { formatMemoryContext } from "./logic.js";
import { updateMemoryArchiveTool, recordKeyEventTool } from "./tools.js";

export default function register(registrar: PluginRegistrar): void {
  registrar.addTool("update-memory-archive", updateMemoryArchiveTool);
  registrar.addTool("record-key-event", recordKeyEventTool);
  registrar.addContextProvider("memory-archive", memoryContextProvider);
}

// ── Context Provider ────────────────────────────────────────────

/**
 * Injects the current memory archive summary into all runtimes' context.
 * Other runtimes see this as a compressed history section in their prompt.
 */
const memoryContextProvider: ContextProvider = async (
  ctx: ContextProviderInput
): Promise<unknown> => {
  const stateObj = ctx.state as Record<string, unknown> | undefined;
  const archive = stateObj?.memoryArchive;

  const content = formatMemoryContext(archive);

  if (!content) {
    return null;
  }

  return {
    title: "Memory Archive",
    content,
    priority: 80,
  };
};
