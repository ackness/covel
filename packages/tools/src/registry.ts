/**
 * Tool registry — registers, looks up, and manages tools.
 */

import type { RuntimeManifest } from '@covel/shared';
import type { ResolvedTool, ToolModule } from './types.js';

export interface ToolRegistry {
  /** Register a resolved tool. */
  register(tool: ResolvedTool): void;

  /** Look up by full name (covel_xxx_xxx_xxx). */
  getByFullName(fullName: string): ResolvedTool | undefined;

  /** Get all tools available to a specific runtime. */
  getToolsForRuntime(
    pluginId: string,
    runtimeId: string,
    manifest: RuntimeManifest,
  ): readonly ResolvedTool[];

  /** Unregister all tools for a plugin. */
  unregisterPlugin(pluginId: string): void;

  /** Get count of registered tools. */
  readonly size: number;
}

/**
 * Generate the full tool name: covel_{plugin}_{runtime}_{fn}
 * Converts hyphens to underscores.
 */
export function generateToolName(pluginId: string, runtimeId: string, localName: string): string {
  const normalize = (s: string): string => s.replace(/-/g, '_');
  return `covel_${normalize(pluginId)}_${normalize(runtimeId)}_${normalize(localName)}`;
}

/**
 * Create an in-memory tool registry.
 */
export function createToolRegistry(): ToolRegistry {
  const tools = new Map<string, ResolvedTool>();

  return {
    register(resolved: ResolvedTool): void {
      tools.set(resolved.fullName, resolved);
    },

    getByFullName(fullName: string): ResolvedTool | undefined {
      return tools.get(fullName);
    },

    getToolsForRuntime(
      pluginId: string,
      runtimeId: string,
      manifest: RuntimeManifest,
    ): readonly ResolvedTool[] {
      const result: ResolvedTool[] = [];
      const builtinNames = new Set(manifest.tools?.builtin ?? []);
      const localPaths = new Set(manifest.tools?.local ?? []);

      for (const resolved of tools.values()) {
        if (resolved.source === 'builtin' && builtinNames.has(resolved.localName)) {
          result.push(resolved);
        } else if (
          resolved.source === 'local' &&
          resolved.pluginId === pluginId &&
          resolved.runtimeId === runtimeId &&
          hasMatchingLocalPath(localPaths, resolved.localName)
        ) {
          result.push(resolved);
        }
      }

      return result;
    },

    unregisterPlugin(pluginId: string): void {
      for (const [fullName, resolved] of tools) {
        if (resolved.pluginId === pluginId) {
          tools.delete(fullName);
        }
      }
    },

    get size(): number {
      return tools.size;
    },
  };
}

/**
 * Check if a local tool name matches any of the declared local paths.
 * Local paths are like './tools/my-tool.js' — we extract the basename without extension.
 */
function hasMatchingLocalPath(localPaths: ReadonlySet<string>, localName: string): boolean {
  for (const path of localPaths) {
    const basename = path.split('/').pop()?.replace(/\.[^.]+$/, '') ?? '';
    if (basename === localName) {
      return true;
    }
  }
  return false;
}
