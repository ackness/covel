import type { PublicToolDefinition } from "@covel/shared";
import type { RegisteredTool, ToolHandler } from "../types.js";

/**
 * Registry for tool handlers from all plugins.
 * Tools are keyed by qualified ID: `pluginId:toolId`.
 */
export function createToolRegistry() {
  const tools = new Map<string, RegisteredTool>();

  function qualifiedId(pluginId: string, toolId: string): string {
    return `${pluginId}:${toolId}`;
  }

  function register(
    pluginId: string,
    definition: PublicToolDefinition,
    handler: ToolHandler
  ): void {
    const qid = qualifiedId(pluginId, definition.id);
    if (tools.has(qid)) {
      throw new Error(`Tool "${qid}" is already registered.`);
    }
    tools.set(qid, { pluginId, definition, handler });
  }

  function get(pluginId: string, toolId: string): RegisteredTool | undefined {
    return tools.get(qualifiedId(pluginId, toolId));
  }

  /** Get a tool by its qualified ID (pluginId:toolId). */
  function getByQualifiedId(qid: string): RegisteredTool | undefined {
    return tools.get(qid);
  }

  /** List all tools for a specific plugin. */
  function listByPlugin(pluginId: string): RegisteredTool[] {
    return Array.from(tools.values()).filter((t) => t.pluginId === pluginId);
  }

  /** List all registered tools. */
  function listAll(): RegisteredTool[] {
    return Array.from(tools.values());
  }

  /** Remove all tools for a plugin. */
  function removeByPlugin(pluginId: string): void {
    for (const [key, tool] of tools) {
      if (tool.pluginId === pluginId) {
        tools.delete(key);
      }
    }
  }

  return {
    register,
    get,
    getByQualifiedId,
    listByPlugin,
    listAll,
    removeByPlugin,
  };
}

export type ToolRegistry = ReturnType<typeof createToolRegistry>;
