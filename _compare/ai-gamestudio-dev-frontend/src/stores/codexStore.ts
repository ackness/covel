import { create } from 'zustand'

export interface CodexEntry {
  action: 'unlock' | 'update'
  category: 'monster' | 'item' | 'location' | 'lore' | 'character'
  entry_id: string
  title: string
  content: string
  tags?: string[]
  image_hint?: string
  _isNew?: boolean
  _newAt?: number
}

interface CodexState {
  entries: CodexEntry[]
  loading: boolean
  searchQuery: string
  setSearchQuery: (q: string) => void
  fetchEntries: (projectId: string) => Promise<void>
  addEntry: (entry: CodexEntry) => void
  markEntrySeen: (entryId: string) => void
  markEntriesSeen: (entryIds: string[]) => void
  clearNewFlags: () => void
}

export const useCodexStore = create<CodexState>((set, get) => ({
  entries: [],
  loading: false,
  searchQuery: '',
  setSearchQuery: (q) => set({ searchQuery: q }),

  fetchEntries: async (projectId: string) => {
    set({ loading: true })
    try {
      const resp = await fetch(`/api/plugins/codex/${projectId}`)
      if (resp.ok) {
        const data = await resp.json()
        const incoming: unknown[] = Array.isArray(data.entries) ? data.entries : []
        const prevMap = new Map(
          get().entries.map((entry) => [entry.entry_id, entry] as const),
        )
        const merged = incoming
          .filter((entry: unknown): entry is CodexEntry => !!entry && typeof entry === 'object')
          .map((entry) => {
            const previous = prevMap.get(entry.entry_id)
            return {
              ...entry,
              _isNew: previous?._isNew === true,
              _newAt: previous?._newAt,
            }
          })
        set({ entries: merged, loading: false })
      } else {
        set({ loading: false })
      }
    } catch {
      set({ loading: false })
    }
  },

  addEntry: (entry: CodexEntry) => {
    const entries = get().entries
    const idx = entries.findIndex((e) => e.entry_id === entry.entry_id)
    const tagged = { ...entry, _isNew: true, _newAt: Date.now() }
    if (idx >= 0) {
      const updated = [...entries]
      updated[idx] = tagged
      set({ entries: updated })
    } else {
      set({ entries: [...entries, tagged] })
    }
  },

  markEntrySeen: (entryId: string) => {
    if (!entryId) return
    set({
      entries: get().entries.map((entry) =>
        entry.entry_id === entryId
          ? { ...entry, _isNew: false, _newAt: undefined }
          : entry,
      ),
    })
  },

  markEntriesSeen: (entryIds: string[]) => {
    const ids = new Set(
      entryIds
        .map((id) => String(id || '').trim())
        .filter((id) => id.length > 0),
    )
    if (ids.size === 0) return
    set({
      entries: get().entries.map((entry) =>
        ids.has(entry.entry_id)
          ? { ...entry, _isNew: false, _newAt: undefined }
          : entry,
      ),
    })
  },

  clearNewFlags: () => {
    set({
      entries: get().entries.map((entry) => ({
        ...entry,
        _isNew: false,
        _newAt: undefined,
      })),
    })
  },
}))
