import { create } from 'zustand'
import type { Plugin } from '../types'

interface PluginStore {
  plugins: Plugin[]
  blockConflicts: { block_type: string; overridden_plugin: string; winner_plugin: string }[]
  loading: boolean
  fetchPlugins: (projectId?: string) => Promise<void>
  togglePlugin: (name: string, projectId: string, enabled: boolean) => Promise<void>
}

interface EnabledPluginState {
  plugin_name: string
  enabled: boolean
  required: boolean
  auto_enabled: boolean
  explicitly_disabled: boolean
  dependencies: string[]
  required_by: string[]
}

export interface PluginApiDeps {
  getPlugins: () => Promise<Plugin[]>
  getEnabledPlugins: (projectId: string) => Promise<EnabledPluginState[]>
  getPluginBlockConflicts: (projectId: string) => Promise<
    { block_type: string; overridden_plugin: string; winner_plugin: string }[]
  >
  togglePlugin: (name: string, projectId: string, enabled: boolean) => Promise<{ ok: boolean }>
}

export function createPluginStore(deps: PluginApiDeps) {
  return create<PluginStore>((set, get) => ({
    plugins: [],
    blockConflicts: [],
    loading: false,

    fetchPlugins: async (projectId) => {
      set({ loading: true })
      try {
        const raw = await deps.getPlugins()

        let enabledMap = new Map<string, EnabledPluginState>()
        let conflicts: { block_type: string; overridden_plugin: string; winner_plugin: string }[] = []
        if (projectId) {
          try {
            const enabled = await deps.getEnabledPlugins(projectId)
            enabledMap = new Map(enabled.map((e) => [e.plugin_name, e] as const))
          } catch {
            // ignore — fall back to defaults
          }
          try {
            conflicts = await deps.getPluginBlockConflicts(projectId)
          } catch {
            // ignore — fall back to defaults
          }
        }

        const plugins: Plugin[] = raw.map((p) => ({
          name: p.name,
          description: p.description,
          type: p.type,
          required: p.required,
          default_enabled: p.default_enabled || false,
          supersedes: p.supersedes || [],
          enabled: p.required ? true : enabledMap.has(p.name),
          auto_enabled: enabledMap.get(p.name)?.auto_enabled ?? false,
          explicitly_disabled: enabledMap.get(p.name)?.explicitly_disabled ?? false,
          dependencies: p.dependencies || enabledMap.get(p.name)?.dependencies || [],
          required_by: enabledMap.get(p.name)?.required_by || [],
          version: p.version || '',
          capabilities: p.capabilities || [],
          has_script_capability: !!p.has_script_capability,
          i18n: p.i18n || {},
        }))
        set({ plugins, blockConflicts: conflicts, loading: false })
      } catch {
        set({ loading: false })
      }
    },

    togglePlugin: async (name, projectId, enabled) => {
      try {
        await deps.togglePlugin(name, projectId, enabled)
        await get().fetchPlugins(projectId)
      } catch {
        // ignore
      }
    },
  }))
}

// Re-export the singleton from the instance file so existing imports of
// `usePluginStore` from this module continue to work.
export { usePluginStore } from './pluginStoreInstance.js'
