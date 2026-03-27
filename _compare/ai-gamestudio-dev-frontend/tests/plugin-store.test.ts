import assert from 'node:assert/strict'
import test from 'node:test'
import { create } from 'zustand'

// ---------------------------------------------------------------------------
// Inline types and createPluginStore to avoid transitive api.ts import chain
// (api.ts -> browserLlmConfig.ts fails in Node ESM resolution)
// ---------------------------------------------------------------------------

interface Plugin {
  name: string
  description: string
  type: string
  required: boolean
  default_enabled: boolean
  supersedes: string[]
  enabled: boolean
  auto_enabled: boolean
  explicitly_disabled: boolean
  dependencies: string[]
  required_by: string[]
  version: string
  capabilities: string[]
  has_script_capability: boolean
  i18n: Record<string, unknown>
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

interface PluginApiDeps {
  getPlugins: () => Promise<Plugin[]>
  getEnabledPlugins: (projectId: string) => Promise<EnabledPluginState[]>
  getPluginBlockConflicts: (projectId: string) => Promise<
    { block_type: string; overridden_plugin: string; winner_plugin: string }[]
  >
  togglePlugin: (name: string, projectId: string, enabled: boolean) => Promise<{ ok: boolean }>
}

interface PluginStore {
  plugins: Plugin[]
  blockConflicts: { block_type: string; overridden_plugin: string; winner_plugin: string }[]
  loading: boolean
  fetchPlugins: (projectId?: string) => Promise<void>
  togglePlugin: (name: string, projectId: string, enabled: boolean) => Promise<void>
}

function createPluginStore(deps: PluginApiDeps) {
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
          } catch { /* ignore */ }
          try {
            conflicts = await deps.getPluginBlockConflicts(projectId)
          } catch { /* ignore */ }
        }
        const plugins: Plugin[] = raw.map((p) => ({
          name: p.name, description: p.description, type: p.type, required: p.required,
          default_enabled: p.default_enabled || false, supersedes: p.supersedes || [],
          enabled: p.required ? true : enabledMap.has(p.name),
          auto_enabled: enabledMap.get(p.name)?.auto_enabled ?? false,
          explicitly_disabled: enabledMap.get(p.name)?.explicitly_disabled ?? false,
          dependencies: p.dependencies || enabledMap.get(p.name)?.dependencies || [],
          required_by: enabledMap.get(p.name)?.required_by || [],
          version: p.version || '', capabilities: p.capabilities || [],
          has_script_capability: !!p.has_script_capability, i18n: p.i18n || {},
        }))
        set({ plugins, blockConflicts: conflicts, loading: false })
      } catch { set({ loading: false }) }
    },
    togglePlugin: async (name, projectId, enabled) => {
      try {
        await deps.togglePlugin(name, projectId, enabled)
        await get().fetchPlugins(projectId)
      } catch { /* ignore */ }
    },
  }))
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type RawPlugin = Omit<Plugin, 'enabled' | 'auto_enabled' | 'explicitly_disabled' | 'required_by'>

function makeRawPlugin(overrides: Partial<RawPlugin> = {}): RawPlugin {
  return {
    name: 'test-plugin', description: 'A test plugin', type: 'gameplay',
    required: false, default_enabled: false, supersedes: [], dependencies: [],
    version: '1.0.0', capabilities: [], has_script_capability: false, i18n: {},
    ...overrides,
  }
}

function makeEnabledState(overrides: Partial<EnabledPluginState> = {}): EnabledPluginState {
  return {
    plugin_name: 'test-plugin', enabled: true, required: false,
    auto_enabled: false, explicitly_disabled: false, dependencies: [], required_by: [],
    ...overrides,
  }
}

function makeDeps(overrides: Partial<PluginApiDeps> = {}): PluginApiDeps {
  return {
    getPlugins: async () => [],
    getEnabledPlugins: async () => [],
    getPluginBlockConflicts: async () => [],
    togglePlugin: async () => ({ ok: true }),
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test('initial state has empty plugins, no conflicts, and loading false', () => {
  const store = createPluginStore(makeDeps())
  const { plugins, blockConflicts, loading } = store.getState()
  assert.deepEqual(plugins, [])
  assert.deepEqual(blockConflicts, [])
  assert.equal(loading, false)
})

test('fetchPlugins without projectId sets plugins from api and clears loading', async () => {
  const raw = [makeRawPlugin({ name: 'choices', required: false })]
  const store = createPluginStore(makeDeps({ getPlugins: async () => raw as Plugin[] }))
  await store.getState().fetchPlugins()
  const { plugins, loading } = store.getState()
  assert.equal(loading, false)
  assert.equal(plugins.length, 1)
  assert.equal(plugins[0].name, 'choices')
  assert.equal(plugins[0].enabled, false)
})

test('fetchPlugins marks required plugin as enabled', async () => {
  const raw = [makeRawPlugin({ name: 'core-blocks', required: true, type: 'global' })]
  const store = createPluginStore(makeDeps({ getPlugins: async () => raw as Plugin[] }))
  await store.getState().fetchPlugins()
  assert.equal(store.getState().plugins[0].enabled, true)
})

test('fetchPlugins sets loading false even when getPlugins throws', async () => {
  const store = createPluginStore(makeDeps({
    getPlugins: async () => { throw new Error('network error') },
  }))
  await store.getState().fetchPlugins()
  assert.equal(store.getState().loading, false)
})

test('fetchPlugins normalises missing optional fields with defaults', async () => {
  const raw = [{ name: 'bare', description: 'Minimal', type: 'gameplay' as const, required: false }]
  const store = createPluginStore(makeDeps({ getPlugins: async () => raw as Plugin[] }))
  await store.getState().fetchPlugins()
  const p = store.getState().plugins[0]
  assert.equal(p.version, '')
  assert.deepEqual(p.capabilities, [])
  assert.equal(p.has_script_capability, false)
})

test('fetchPlugins with projectId merges enabled state', async () => {
  const raw = [makeRawPlugin({ name: 'memory', required: false, dependencies: undefined as unknown as string[] })]
  const enabled = [makeEnabledState({ plugin_name: 'memory', auto_enabled: true, dependencies: ['database'] })]
  const store = createPluginStore(makeDeps({
    getPlugins: async () => raw as Plugin[],
    getEnabledPlugins: async () => enabled,
  }))
  await store.getState().fetchPlugins('proj-1')
  const p = store.getState().plugins[0]
  assert.equal(p.enabled, true)
  assert.equal(p.auto_enabled, true)
  assert.deepEqual(p.dependencies, ['database'])
})

test('fetchPlugins with projectId stores block conflicts', async () => {
  const raw = [makeRawPlugin({ name: 'auto-guide', supersedes: ['choices'] })]
  const conflicts = [{ block_type: 'choices', overridden_plugin: 'choices', winner_plugin: 'auto-guide' }]
  const store = createPluginStore(makeDeps({
    getPlugins: async () => raw as Plugin[],
    getPluginBlockConflicts: async () => conflicts,
  }))
  await store.getState().fetchPlugins('proj-1')
  assert.equal(store.getState().blockConflicts.length, 1)
  assert.equal(store.getState().blockConflicts[0].winner_plugin, 'auto-guide')
})

test('fetchPlugins continues when getEnabledPlugins throws', async () => {
  const raw = [makeRawPlugin({ name: 'dice-roll' })]
  const store = createPluginStore(makeDeps({
    getPlugins: async () => raw as Plugin[],
    getEnabledPlugins: async () => { throw new Error('forbidden') },
  }))
  await store.getState().fetchPlugins('proj-1')
  assert.equal(store.getState().loading, false)
  assert.equal(store.getState().plugins[0].enabled, false)
})

test('togglePlugin calls api then re-fetches plugins', async () => {
  const raw = [makeRawPlugin({ name: 'choices' })]
  const enabled = [makeEnabledState({ plugin_name: 'choices', enabled: true })]
  let toggleCalled = false
  const store = createPluginStore(makeDeps({
    getPlugins: async () => raw as Plugin[],
    getEnabledPlugins: async () => enabled,
    togglePlugin: async () => { toggleCalled = true; return { ok: true } },
  }))
  await store.getState().togglePlugin('choices', 'proj-1', true)
  assert.equal(toggleCalled, true)
  assert.equal(store.getState().plugins[0].enabled, true)
})

test('togglePlugin silently ignores api errors', async () => {
  const store = createPluginStore(makeDeps({
    togglePlugin: async () => { throw new Error('server error') },
  }))
  await store.getState().togglePlugin('choices', 'proj-1', true)
  assert.deepEqual(store.getState().plugins, [])
})

test('togglePlugin passes correct arguments to api', async () => {
  const calls: [string, string, boolean][] = []
  const store = createPluginStore(makeDeps({
    togglePlugin: async (name, projectId, enabled) => {
      calls.push([name, projectId, enabled])
      return { ok: true }
    },
  }))
  await store.getState().togglePlugin('memory', 'proj-42', false)
  assert.equal(calls.length, 1)
  assert.deepEqual(calls[0], ['memory', 'proj-42', false])
})
