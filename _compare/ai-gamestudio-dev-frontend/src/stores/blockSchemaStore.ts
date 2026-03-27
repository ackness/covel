import { create } from 'zustand'

export interface UISchemaSection {
  type: string // 'key-value' | 'text' | 'list' | 'table' | 'progress' | 'tags'
  items?: { label: string; value: string }[]
  content?: string
  values?: string[]
  columns?: string[]
  rows?: string[][]
  label?: string
  current?: string
  max?: string
}

export interface UISchemaAction {
  label: string
  action_template: string
  for_each?: string
}

export interface UISchema {
  component: string // 'card' | 'buttons' | 'banner' | 'custom' | 'none'
  renderer_name?: string
  title?: string
  text?: string
  sections?: UISchemaSection[]
  actions?: UISchemaAction[]
  style?: Record<string, string>
  requires_response: boolean
  plugin_name: string
  schema?: Record<string, unknown>
}

interface BlockSchemaStore {
  schemas: Record<string, UISchema>
  loaded: boolean
  fetchSchemas: (projectId: string) => Promise<void>
  clear: () => void
}

export const useBlockSchemaStore = create<BlockSchemaStore>((set) => ({
  schemas: {},
  loaded: false,

  fetchSchemas: async (projectId: string) => {
    try {
      const res = await fetch(`/api/plugins/block-schemas?project_id=${encodeURIComponent(projectId)}`)
      if (!res.ok) throw new Error('Failed to fetch block schemas')
      const data = await res.json()
      set({ schemas: data, loaded: true })
    } catch {
      set({ schemas: {}, loaded: true })
    }
  },

  clear: () => set({ schemas: {}, loaded: false }),
}))
