import type {
  Project,
  Session,
  Message,
  Plugin,
  PluginDetail,
  Scene,
  GameEvent,
  Character,
  LlmProfile,
  ArchiveVersion,
  WorldTemplate,
  WorldTemplateDetail,
  PresetModel,
  RuntimeSettingField,
  StoryImageData,
} from '../types'
import { buildBrowserLlmHeaders } from '../utils/browserLlmConfig'
import { useProjectStore } from '../stores/projectStore'

function getBaseUrl(): string {
  const configured = String(import.meta.env.VITE_API_BASE_URL || '').trim()
  const base = configured || '/api'
  return base.endsWith('/') ? base.slice(0, -1) : base
}

const BASE_URL = getBaseUrl()

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...buildBrowserLlmHeaders(useProjectStore.getState().currentProject?.id),
  }
  const accessKey = String(import.meta.env.VITE_ACCESS_KEY || '').trim()
  if (accessKey) headers['X-Access-Key'] = accessKey
  const res = await fetch(`${BASE_URL}${path}`, {
    headers: { ...headers, ...options?.headers },
    ...options,
  })
  if (!res.ok) {
    const error = await res.text()
    throw new Error(`API Error ${res.status}: ${error}`)
  }
  return res.json()
}

// Projects
export function getProjects(): Promise<Project[]> {
  return request('/projects')
}

export function createProject(data: { id?: string; name: string; description?: string; world_doc?: string }): Promise<Project> {
  return request('/projects', {
    method: 'POST',
    body: JSON.stringify(data),
  })
}

export function getProject(id: string): Promise<Project> {
  return request(`/projects/${id}`)
}

export function updateProject(id: string, data: Partial<Project>): Promise<Project> {
  return request(`/projects/${id}`, {
    method: 'PUT',
    body: JSON.stringify(data),
  })
}

export function deleteProject(id: string): Promise<void> {
  return request(`/projects/${id}`, { method: 'DELETE' })
}

// Sessions
export function getSessions(projectId: string): Promise<Session[]> {
  return request(`/projects/${projectId}/sessions`)
}

export function createSession(projectId: string, sessionId?: string): Promise<Session> {
  return request(`/projects/${projectId}/sessions`, {
    method: 'POST',
    body: JSON.stringify(sessionId ? { id: sessionId } : {}),
  })
}

export function deleteSession(sessionId: string): Promise<void> {
  return request(`/sessions/${sessionId}`, { method: 'DELETE' })
}

export function getSessionState(sessionId: string): Promise<{
  world: Record<string, unknown>
  turn_count: number
  token_usage?: {
    total_prompt_tokens?: number
    total_completion_tokens?: number
    total_cost?: number
  }
}> {
  return request(`/sessions/${sessionId}/state`)
}

// Archive Versions
export function getArchiveVersions(sessionId: string): Promise<ArchiveVersion[]> {
  return request(`/sessions/${sessionId}/archives`)
}

export function summarizeArchive(sessionId: string, reason?: string): Promise<ArchiveVersion> {
  return request(`/sessions/${sessionId}/archives/summarize`, {
    method: 'POST',
    body: JSON.stringify({ reason }),
  })
}

export function restoreArchiveVersion(
  sessionId: string,
  version: number,
  mode: 'hard' | 'fork' = 'fork',
): Promise<{
  ok: boolean
  mode: 'hard' | 'fork'
  session_id: string
  new_session_id?: string
  source_session_id?: string
  version: number
  title: string
  summary: string
  phase: string
}> {
  return request(`/sessions/${sessionId}/archives/${version}/restore`, {
    method: 'POST',
    body: JSON.stringify({ mode }),
  })
}

// Messages
export function getMessages(sessionId: string): Promise<Message[]> {
  return request(`/sessions/${sessionId}/messages`)
}

// Plugins
export function getPlugins(): Promise<Plugin[]> {
  return request('/plugins')
}

export function getEnabledPlugins(projectId: string): Promise<{
  plugin_name: string
  enabled: boolean
  required: boolean
  auto_enabled: boolean
  explicitly_disabled: boolean
  dependencies: string[]
  required_by: string[]
}[]> {
  return request(`/plugins/enabled/${projectId}`)
}

export function getPluginBlockConflicts(projectId: string): Promise<{
  block_type: string
  overridden_plugin: string
  winner_plugin: string
}[]> {
  return request(`/plugins/block-conflicts?project_id=${encodeURIComponent(projectId)}`)
}

export function togglePlugin(name: string, projectId: string, enabled: boolean): Promise<{ ok: boolean }> {
  return request(`/plugins/${name}/toggle`, {
    method: 'POST',
    body: JSON.stringify({ project_id: projectId, enabled }),
  })
}

export function getPluginDetail(name: string): Promise<PluginDetail> {
  return request(`/plugins/${name}/detail`)
}

// Scenes
export function getScenes(sessionId: string): Promise<Scene[]> {
  return request(`/sessions/${sessionId}/scenes`)
}

export function getCurrentScene(sessionId: string): Promise<Scene> {
  return request(`/sessions/${sessionId}/scenes/current`)
}

// Events
export function getEvents(sessionId: string, status?: string): Promise<GameEvent[]> {
  const query = status ? `?status=${encodeURIComponent(status)}` : ''
  return request(`/sessions/${sessionId}/events${query}`)
}

// Characters
export function getCharacters(sessionId: string): Promise<Character[]> {
  return request(`/sessions/${sessionId}/characters`)
}

export function updateCharacter(characterId: string, changes: Record<string, unknown>): Promise<Character> {
  return request(`/characters/${characterId}`, {
    method: 'PUT',
    body: JSON.stringify(changes),
  })
}

// LLM Info
export interface LlmInfo {
  model: string
  model_name: string
  provider: string
  api_base: string | null
  has_key: boolean
  source: 'project' | 'profile' | 'env' | 'default'
}

export function getLlmInfo(projectId?: string): Promise<LlmInfo> {
  const query = projectId ? `?project_id=${encodeURIComponent(projectId)}` : ''
  return request(`/llm/info${query}`)
}

export async function testLlm(): Promise<{ ok: boolean; reply?: string; latency_ms: number; error?: string }> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...buildBrowserLlmHeaders(useProjectStore.getState().currentProject?.id),
  }
  const accessKey = String(import.meta.env.VITE_ACCESS_KEY || '').trim()
  if (accessKey) headers['X-Access-Key'] = accessKey
  const res = await fetch(`${BASE_URL}/llm/test`, { method: 'POST', headers })
  return res.json()
}

// LLM Profiles
export function getLlmProfiles(): Promise<LlmProfile[]> {
  return request('/llm/profiles')
}

export function getPresetModels(): Promise<PresetModel[]> {
  return request('/llm/preset-models')
}

export function createLlmProfile(data: { name: string; model: string; api_key?: string; api_base?: string }): Promise<LlmProfile> {
  return request('/llm/profiles', {
    method: 'POST',
    body: JSON.stringify(data),
  })
}

export function updateLlmProfile(
  id: string,
  data: { name?: string; model?: string; api_key?: string; api_base?: string },
): Promise<LlmProfile> {
  return request(`/llm/profiles/${id}`, {
    method: 'PUT',
    body: JSON.stringify(data),
  })
}

export function deleteLlmProfile(id: string): Promise<void> {
  return request(`/llm/profiles/${id}`, { method: 'DELETE' })
}

export function applyLlmProfile(profileId: string, projectId: string): Promise<{ ok: boolean }> {
  return request(`/llm/profiles/${profileId}/apply`, {
    method: 'POST',
    body: JSON.stringify({ project_id: projectId }),
  })
}

// World Templates
export async function getWorldTemplates(lang?: string): Promise<WorldTemplate[]> {
  const query = lang ? `?lang=${encodeURIComponent(lang)}` : ''
  try {
    return await request(`/templates/worlds${query}`)
  } catch (error) {
    if (lang && lang !== 'en') {
      return request('/templates/worlds?lang=en')
    }
    throw error
  }
}

export async function getWorldTemplate(slug: string, lang?: string): Promise<WorldTemplateDetail> {
  const query = lang ? `?lang=${encodeURIComponent(lang)}` : ''
  try {
    return await request(`/templates/worlds/${slug}${query}`)
  } catch (error) {
    if (lang && lang !== 'en') {
      return request(`/templates/worlds/${slug}?lang=en`)
    }
    throw error
  }
}

async function streamRequest(path: string, data: unknown, onChunk: (text: string) => void, signal?: AbortSignal): Promise<void> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...buildBrowserLlmHeaders(useProjectStore.getState().currentProject?.id),
  }
  const accessKey = String(import.meta.env.VITE_ACCESS_KEY || '').trim()
  if (accessKey) headers['X-Access-Key'] = accessKey
  const res = await fetch(`${BASE_URL}${path}`, { method: 'POST', headers, body: JSON.stringify(data), signal })
  if (!res.ok) throw new Error(`API Error ${res.status}: ${await res.text()}`)
  const reader = res.body!.pipeThrough(new TextDecoderStream()).getReader()
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    onChunk(value)
  }
}

export function generateWorldStream(
  data: { genre: string; setting?: string; tone?: string; language?: string; extra_notes?: string },
  onChunk: (text: string) => void, signal?: AbortSignal,
) { return streamRequest('/templates/worlds/generate', data, onChunk, signal) }

export interface ReviseEdit {
  old_text: string
  new_text: string
}

export interface ReviseWorldResult {
  mode: 'search_replace' | 'full'
  world_doc: string
  edits: ReviseEdit[]
}

export function reviseWorld(
  data: { world_doc: string; instruction: string; language?: string },
): Promise<ReviseWorldResult> {
  return request('/templates/worlds/revise', {
    method: 'POST',
    body: JSON.stringify(data),
  })
}

// Runtime settings
export interface RuntimeSettingsSchemaResponse {
  fields: RuntimeSettingField[]
  by_plugin: Record<string, string[]>
  enabled_plugins: string[]
}

export interface RuntimeSettingsValuesResponse {
  values: Record<string, unknown>
  by_plugin: Record<string, Record<string, unknown>>
  project_overrides: Record<string, unknown>
  session_overrides: Record<string, unknown>
}

export function getRuntimeSettingsSchema(projectId: string): Promise<RuntimeSettingsSchemaResponse> {
  return request(`/runtime-settings/schema?project_id=${encodeURIComponent(projectId)}`)
}

export function getRuntimeSettings(projectId: string, sessionId?: string): Promise<RuntimeSettingsValuesResponse> {
  const params = new URLSearchParams({ project_id: projectId })
  if (sessionId) params.set('session_id', sessionId)
  return request(`/runtime-settings?${params.toString()}`)
}

export function patchRuntimeSettings(data: {
  project_id: string
  session_id?: string
  scope: 'project' | 'session'
  values: Record<string, unknown>
}): Promise<RuntimeSettingsValuesResponse & { ok: boolean }> {
  return request('/runtime-settings', {
    method: 'PATCH',
    body: JSON.stringify(data),
  })
}

// Plugin Import & Audit
export function validatePluginImport(pluginDir: string): Promise<{
  valid: boolean
  errors: string[]
  warnings: string[]
}> {
  return request('/plugins/import/validate', {
    method: 'POST',
    body: JSON.stringify({ plugin_dir: pluginDir }),
  })
}

export function getPluginAudit(pluginName: string, limit?: number): Promise<Record<string, unknown>[]> {
  const query = limit ? `?limit=${limit}` : ''
  return request(`/plugins/${encodeURIComponent(pluginName)}/audit${query}`)
}

// Session Story Images
export async function getSessionStoryImages(sessionId: string): Promise<StoryImageData[]> {
  try {
    return await request(`/sessions/${sessionId}/story-images`)
  } catch {
    return []
  }
}

// Debug Prompt Preview
export interface DebugPromptMessage {
  role: string
  content: string
  length: number
}

export interface DebugPluginAgentInfo {
  system_prompt: string
  tools: { name: string; description: string }[]
  block_declarations: Record<string, { plugin: string; schema: Record<string, unknown> | null }>
}

export interface DebugPromptResponse {
  model: string
  api_base: string | null
  source: string
  enabled_plugins: string[]
  messages: DebugPromptMessage[]
  total_chars: number
  message_count: number
  plugin_agent?: DebugPluginAgentInfo
  error?: string
}

export async function getDebugPrompt(sessionId: string): Promise<DebugPromptResponse> {
  return request(`/sessions/${sessionId}/debug-prompt`)
}

// Model Info
export async function getModelInfo(model: string): Promise<{
  model: string
  max_input_tokens: number
  max_output_tokens: number
  max_input_tokens_display: string
  input_cost_per_token: number
  output_cost_per_token: number
  known: boolean
}> {
  return request(`/model-info?model=${encodeURIComponent(model)}`)
}

// Novel Generation
export type NovelEvent =
  | { type: 'outline'; chapters: { title: string; summary: string }[] }
  | { type: 'chapter_chunk'; index: number; text: string }
  | { type: 'chapter'; index: number; title: string; content: string }
  | { type: 'error'; message: string }
  | { type: 'done' }

export async function generateNovelStream(
  sessionId: string,
  options: { style?: string; chapter_count?: number; language?: string },
  onEvent: (event: NovelEvent) => void,
  signal?: AbortSignal,
): Promise<void> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...buildBrowserLlmHeaders(useProjectStore.getState().currentProject?.id),
  }
  const accessKey = String(import.meta.env.VITE_ACCESS_KEY || '').trim()
  if (accessKey) headers['X-Access-Key'] = accessKey

  const res = await fetch(`${BASE_URL}/sessions/${sessionId}/novel/generate`, {
    method: 'POST',
    headers,
    body: JSON.stringify(options),
    signal,
  })
  if (!res.ok) throw new Error(`API Error ${res.status}: ${await res.text()}`)

  const reader = res.body!.pipeThrough(new TextDecoderStream()).getReader()
  let buffer = ''
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += value
    const lines = buffer.split('\n')
    buffer = lines.pop() || ''
    for (const line of lines) {
      if (!line.trim()) continue
      try {
        onEvent(JSON.parse(line))
      } catch { /* intentionally silent: skip malformed SSE lines */ }
    }
  }
  if (buffer.trim()) {
    try { onEvent(JSON.parse(buffer)) } catch { /* intentionally silent: skip malformed SSE trailing buffer */ }
  }
}
