export interface Project {
  id: string
  name: string
  description?: string
  world_doc: string
  init_prompt?: string
  llm_model?: string
  llm_api_key?: string
  llm_api_base?: string
  has_llm_api_key?: boolean
  image_model?: string
  image_api_key?: string
  image_api_base?: string
  has_image_api_key?: boolean
  created_at: string
  updated_at: string
}

export interface Session {
  id: string
  project_id: string
  status: 'active' | 'paused' | 'ended'
  phase: 'init' | 'character_creation' | 'playing' | 'ended'
  game_state?: Record<string, unknown>
  created_at: string
}

export interface Message {
  id: string
  session_id: string
  role: 'user' | 'assistant' | 'system'
  content: string
  turn_id?: string
  message_type: 'chat' | 'narration' | 'system_event'
  scene_id?: string
  raw_content?: string
  blocks?: {
    type: string
    data: unknown
    block_id?: string
    output?: import('../services/outputContract').OutputEnvelope
  }[]
  created_at: string
}

export interface Character {
  id: string
  session_id: string
  name: string
  role: 'player' | 'npc'
  description?: string
  personality?: string
  attributes: Record<string, string | number>
  inventory: (string | { name: string; [key: string]: unknown })[]
}

export interface Scene {
  id: string
  session_id: string
  name: string
  description?: string
  is_current: boolean
  metadata?: Record<string, unknown>
  created_at: string
  updated_at: string
}

export interface SceneNPC {
  id: string
  scene_id: string
  character_id: string
  character_name?: string
  role_in_scene?: string
}

export interface GameEvent {
  id: string
  session_id: string
  event_type: string
  name: string
  description: string
  status: string
  parent_event_id?: string
  source: string
  visibility: string
  children?: GameEvent[]
  created_at: string
  updated_at: string
}

export interface Quest {
  quest_id: string
  title: string
  description?: string
  status: 'active' | 'completed' | 'failed'
  objectives?: { id: string; text: string; completed: boolean }[]
  rewards?: { xp?: number; gold?: number; items?: string[]; type?: string; value?: string }
}

export interface Plugin {
  name: string
  description: string
  type: 'global' | 'gameplay'
  required: boolean
  enabled: boolean
  default_enabled?: boolean
  supersedes?: string[]
  auto_enabled?: boolean
  explicitly_disabled?: boolean
  dependencies?: string[]
  required_by?: string[]
  version?: string
  capabilities?: string[]
  has_script_capability?: boolean
  schema_status?: string
  i18n?: Record<string, { name?: string; description?: string }>
}

export interface PluginDetail {
  name: string
  version: string
  description: string
  type: string
  required: boolean
  default_enabled: boolean
  supersedes: string[]
  dependencies: string[]
  prompt: {
    position: string | null
    priority: number | null
    template: string | null
    content: string | null
  } | null
  outputs: Record<string, {
    instruction?: string
    schema?: Record<string, unknown>
    ui?: Record<string, unknown>
    requires_response?: boolean
  }>
  capabilities: Record<string, { description: string; type: string }>
  i18n: Record<string, { name?: string; description?: string }>
}

export interface LlmProfile {
  id: string
  name: string
  model: string
  api_base?: string
  has_api_key: boolean
  created_at: string
  updated_at: string
}

export interface PresetModel {
  id: string
  name: string
  name_en?: string
  provider: string
  model: string
  api_base: string
  description: string
}

export interface ArchiveVersion {
  version: number
  created_at: string
  trigger: 'auto' | 'manual'
  title: string
  summary: string
  summary_excerpt: string
  turn: number
  active: boolean
}

export interface RuntimeSettingOption {
  label: string
  value: string | number | boolean
  i18n?: Record<string, { label?: string }>
}

export interface RuntimeSettingField {
  key: string
  plugin_name: string
  field: string
  type: 'string' | 'number' | 'integer' | 'boolean' | 'enum'
  label: string
  description?: string
  scope: 'project' | 'session' | 'both'
  component?: string
  order?: number
  affects?: string[]
  options?: RuntimeSettingOption[]
  default?: unknown
  min?: number
  max?: number
  step?: number
  i18n?: Record<string, { label?: string; description?: string; default?: string }>
}

export interface WorldTemplate {
  slug: string
  name: string
  description: string
  genre: string
  tags: string[]
  language: string
}

export interface WorldTemplateDetail extends WorldTemplate {
  content: string
  raw: string
}

export interface StoryImageData {
  image_id?: string
  message_id?: string
  image_url?: string
  title?: string
  status?: string
  error?: string
  created_at?: string
}
