export interface BrowserLlmConfig {
  model?: string
  apiKey?: string
  apiBase?: string
  pluginModel?: string
  pluginApiKey?: string
  pluginApiBase?: string
  pluginReasoningEffort?: string
  imageModel?: string
  imageApiKey?: string
  imageApiBase?: string
  imageApiBaseAutoSuffix?: boolean
}

export interface LlmOverridePayload {
  model?: string
  api_key?: string
  api_base?: string
  plugin_model?: string
  plugin_api_key?: string
  plugin_api_base?: string
  plugin_reasoning_effort?: string
}

export interface ImageOverridePayload {
  model?: string
  api_key?: string
  api_base?: string
  auto_suffix?: boolean
}

const GLOBAL_KEY = 'ai-gamestudio:llm-config:global'
const PROJECT_KEY_PREFIX = 'ai-gamestudio:llm-config:project:'

function getStorage(): Storage | null {
  if (typeof window === 'undefined') return null
  try {
    return window.localStorage
  } catch {
    return null
  }
}

function normalize(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed ? trimmed : undefined
}

function normalizeConfig(raw: Partial<BrowserLlmConfig>): BrowserLlmConfig {
  return {
    model: normalize(raw.model),
    apiKey: normalize(raw.apiKey),
    apiBase: normalize(raw.apiBase),
    pluginModel: normalize(raw.pluginModel),
    pluginApiKey: normalize(raw.pluginApiKey),
    pluginApiBase: normalize(raw.pluginApiBase),
    pluginReasoningEffort: normalize(raw.pluginReasoningEffort),
    imageModel: normalize(raw.imageModel),
    imageApiKey: normalize(raw.imageApiKey),
    imageApiBase: normalize(raw.imageApiBase),
    imageApiBaseAutoSuffix: raw.imageApiBaseAutoSuffix,
  }
}

function projectKey(projectId: string): string {
  return `${PROJECT_KEY_PREFIX}${projectId}`
}

function readConfig(key: string): BrowserLlmConfig {
  const storage = getStorage()
  if (!storage) return {}
  const raw = storage.getItem(key)
  if (!raw) return {}
  try {
    const parsed = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    return normalizeConfig(parsed as Partial<BrowserLlmConfig>)
  } catch {
    return {}
  }
}

function writeConfig(key: string, cfg: BrowserLlmConfig) {
  const storage = getStorage()
  if (!storage) return
  const normalized = normalizeConfig(cfg)
  const hasAnyValue = Object.values(normalized).some((item) => !!item)
  if (!hasAnyValue) {
    storage.removeItem(key)
    return
  }
  storage.setItem(key, JSON.stringify(normalized))
}

export function getBrowserLlmConfig(projectId?: string | null): BrowserLlmConfig {
  const global = readConfig(GLOBAL_KEY)
  if (!projectId) return global
  const project = readConfig(projectKey(projectId))
  return {
    ...global,
    ...project,
  }
}

export function saveBrowserLlmConfig(projectId: string, cfg: Partial<BrowserLlmConfig>): void {
  writeConfig(projectKey(projectId), normalizeConfig(cfg))
}

export function clearBrowserLlmConfig(projectId: string): void {
  const storage = getStorage()
  if (!storage) return
  storage.removeItem(projectKey(projectId))
}

export function buildBrowserLlmHeaders(projectId?: string | null): Record<string, string> {
  const cfg = getBrowserLlmConfig(projectId)
  const headers: Record<string, string> = {}
  if (cfg.model) headers['X-LLM-Model'] = cfg.model
  if (cfg.apiKey) headers['X-LLM-Api-Key'] = cfg.apiKey
  if (cfg.apiBase) headers['X-LLM-Api-Base'] = cfg.apiBase
  return headers
}

export function buildBrowserLlmOverrides(projectId?: string | null): LlmOverridePayload | undefined {
  const cfg = getBrowserLlmConfig(projectId)
  const overrides: LlmOverridePayload = {}
  if (cfg.model) overrides.model = cfg.model
  if (cfg.apiKey) overrides.api_key = cfg.apiKey
  if (cfg.apiBase) overrides.api_base = cfg.apiBase
  if (cfg.pluginModel) overrides.plugin_model = cfg.pluginModel
  if (cfg.pluginApiKey) overrides.plugin_api_key = cfg.pluginApiKey
  if (cfg.pluginApiBase) overrides.plugin_api_base = cfg.pluginApiBase
  if (cfg.pluginReasoningEffort) overrides.plugin_reasoning_effort = cfg.pluginReasoningEffort
  if (!overrides.model && !overrides.api_key && !overrides.api_base && !overrides.plugin_model) {
    return undefined
  }
  return overrides
}

export function buildBrowserImageOverrides(projectId?: string | null): ImageOverridePayload | undefined {
  const cfg = getBrowserLlmConfig(projectId)
  const overrides: ImageOverridePayload = {}
  if (cfg.imageModel) overrides.model = cfg.imageModel
  if (cfg.imageApiKey) overrides.api_key = cfg.imageApiKey
  if (cfg.imageApiBase) overrides.api_base = cfg.imageApiBase
  if (cfg.imageApiBaseAutoSuffix === false) overrides.auto_suffix = false
  if (!overrides.model && !overrides.api_key && !overrides.api_base && overrides.auto_suffix === undefined) {
    return undefined
  }
  return overrides
}
