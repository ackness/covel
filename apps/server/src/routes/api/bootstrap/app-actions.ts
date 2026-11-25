/**
 * Registry for instance-scoped application actions registered via
 * `covel.registerAppAction(action, handler, options?)`.
 */

import {
  FRAMEWORK_PLUGIN_ID,
  rpcActionNameSchema,
  type RpcTrustLevel,
} from "@covel/shared";
import type {
  PluginAppActionHandler,
  PluginAppActionOptions,
} from "@covel/runtime";

export interface AppActionEntry {
  readonly pluginId: string;
  readonly action: string;
  readonly handler: PluginAppActionHandler;
  readonly options: PluginAppActionOptions;
  readonly trustLevel: RpcTrustLevel;
}

export interface AppActionRegistry {
  register<I = unknown, O = unknown>(
    pluginId: string,
    action: string,
    handler: PluginAppActionHandler<I, O>,
    options: PluginAppActionOptions<I, O>,
    trustLevel: RpcTrustLevel,
  ): () => void;
  get(pluginId: string, action: string): AppActionEntry | undefined;
  listForPlugin(pluginId: string): readonly AppActionEntry[];
  replacePlugin<T>(pluginId: string, fn: () => T): T;
}

function entryKey(pluginId: string, action: string): string {
  return `${pluginId}\0${action}`;
}

export function createAppActionRegistry(): AppActionRegistry {
  const entries = new Map<string, AppActionEntry>();

  return {
    register<I = unknown, O = unknown>(
      pluginId: string,
      action: string,
      handler: PluginAppActionHandler<I, O>,
      options: PluginAppActionOptions<I, O>,
      trustLevel: RpcTrustLevel,
    ): () => void {
      if (pluginId === FRAMEWORK_PLUGIN_ID) {
        throw new Error(
          `[app-actions] "${FRAMEWORK_PLUGIN_ID}" is reserved for framework actions`,
        );
      }
      const parsedName = rpcActionNameSchema.safeParse(action);
      if (!parsedName.success) {
        throw new Error(
          parsedName.error.issues.map((issue) => issue.message).join("; "),
        );
      }
      const key = entryKey(pluginId, action);
      if (entries.has(key)) {
        throw new Error(
          `app action "${action}" is already registered in plugin "${pluginId}"`,
        );
      }
      const entry: AppActionEntry = {
        pluginId,
        action,
        handler: handler as PluginAppActionHandler,
        options: options as PluginAppActionOptions,
        trustLevel,
      };
      entries.set(key, entry);
      return () => {
        if (entries.get(key) === entry) {
          entries.delete(key);
        }
      };
    },

    get(pluginId: string, action: string): AppActionEntry | undefined {
      return entries.get(entryKey(pluginId, action));
    },

    listForPlugin(pluginId: string): readonly AppActionEntry[] {
      const result: AppActionEntry[] = [];
      for (const entry of entries.values()) {
        if (entry.pluginId === pluginId) {
          result.push(entry);
        }
      }
      return result;
    },

    replacePlugin<T>(pluginId: string, fn: () => T): T {
      const saved: Array<[string, AppActionEntry]> = [];
      for (const [key, entry] of entries) {
        if (entry.pluginId === pluginId) {
          saved.push([key, entry]);
          entries.delete(key);
        }
      }
      try {
        return fn();
      } catch (error) {
        for (const [key, entry] of [...entries]) {
          if (entry.pluginId === pluginId) {
            entries.delete(key);
          }
        }
        for (const [key, entry] of saved) {
          entries.set(key, entry);
        }
        throw error;
      }
    },
  };
}
