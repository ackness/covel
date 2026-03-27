/**
 * gameDataStore — unified game data store.
 * Merges gameStateStore + sceneStore + codexStore into one Zustand store.
 */
import { create } from 'zustand'
import type { Character, GameEvent, Quest, Scene } from '../types'
import { syncToIdbFireAndForget } from '../services/idbSync'
import { useSessionStore } from './sessionStore'

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

interface GameDataState {
  // Characters & world
  characters: Character[]
  worldState: Record<string, unknown>
  events: GameEvent[]
  quests: Quest[]
  // Scenes
  currentScene: Scene | null
  scenes: Scene[]
  // Codex
  codexEntries: CodexEntry[]
  codexLoading: boolean
  codexSearchQuery: string
}

interface GameDataActions {
  // Characters
  setCharacters: (characters: Character[]) => void
  mergeCharacters: (incoming: Character[]) => void
  updateCharacter: (character: Character) => void
  // World
  setWorldState: (state: Record<string, unknown>) => void
  // Events
  setEvents: (events: GameEvent[]) => void
  addEvent: (event: GameEvent) => void
  updateEvent: (event: GameEvent) => void
  // Quests
  upsertQuest: (quest: Quest) => void
  setQuests: (quests: Quest[]) => void
  // Scenes
  setCurrentScene: (scene: Scene | null) => void
  setScenes: (scenes: Scene[]) => void
  addScene: (scene: Scene) => void
  // Codex
  setCodexSearchQuery: (q: string) => void
  fetchCodexEntries: (projectId: string) => Promise<void>
  addCodexEntry: (entry: CodexEntry) => void
  markEntrySeen: (entryId: string) => void
  markEntriesSeen: (entryIds: string[]) => void
  clearNewFlags: () => void
  // Reset
  reset: () => void
}

const INITIAL_STATE: GameDataState = {
  characters: [],
  worldState: {},
  events: [],
  quests: [],
  currentScene: null,
  scenes: [],
  codexEntries: [],
  codexLoading: false,
  codexSearchQuery: '',
}

function writeCharsToIdb(characters: Character[]) {
  if (characters.length === 0) return
  const sessionId = useSessionStore.getState().currentSession?.id
  characters.forEach((c) => {
    const record = c as unknown as Record<string, unknown>
    const withSession =
      record.session_id || !sessionId
        ? record
        : { ...record, session_id: sessionId }
    syncToIdbFireAndForget('character', withSession)
  })
}

function writeEventsToIdb(events: GameEvent[]) {
  if (events.length === 0) return
  events.forEach((e) => syncToIdbFireAndForget('event', e))
}

export const useGameDataStore = create<GameDataState & GameDataActions>(
  (set, get) => ({
    ...INITIAL_STATE,

    // ── Characters ──

    setCharacters: (characters) => {
      set({ characters })
      writeCharsToIdb(characters)
    },

    mergeCharacters: (incoming) => {
      let merged: Character[] = []
      set((state) => {
        const map = new Map(state.characters.map((c) => [c.id, c]))
        const nameToId = new Map(state.characters.map((c) => [c.name, c.id]))
        for (const c of incoming) {
          const key = c.id || nameToId.get(c.name)
          if (key) {
            const existing = map.get(key)
            map.set(key, { ...existing, ...c, id: key } as Character)
          } else {
            const id = c.id || `temp-${c.name}`
            map.set(id, { ...c, id } as Character)
          }
        }
        merged = Array.from(map.values())
        return { characters: merged }
      })
      writeCharsToIdb(merged)
    },

    updateCharacter: (character) => {
      set((state) => ({
        characters: state.characters.map((c) =>
          c.id === character.id ? character : c,
        ),
      }))
      writeCharsToIdb([character])
    },

    // ── World ──

    setWorldState: (worldState) => set({ worldState }),

    // ── Events ──

    setEvents: (events) => {
      set({ events })
      writeEventsToIdb(events)
    },

    addEvent: (event) => {
      set((state) => ({ events: [...state.events, event] }))
      writeEventsToIdb([event])
    },

    updateEvent: (event) => {
      set((state) => ({
        events: state.events.map((e) => (e.id === event.id ? event : e)),
      }))
      writeEventsToIdb([event])
    },

    // ── Quests ──

    upsertQuest: (quest) => {
      set((state) => {
        const idx = state.quests.findIndex(
          (q) => q.quest_id === quest.quest_id,
        )
        if (idx >= 0) {
          const updated = [...state.quests]
          updated[idx] = { ...updated[idx], ...quest }
          return { quests: updated }
        }
        return { quests: [...state.quests, quest] }
      })
    },

    setQuests: (quests) => set({ quests }),

    // ── Scenes ──

    setCurrentScene: (currentScene) => set({ currentScene }),

    setScenes: (scenes) => {
      set({ scenes })
      if (scenes.length > 0) {
        scenes.forEach((s) => syncToIdbFireAndForget('scene', s))
      }
    },

    addScene: (scene) => {
      set((state) => ({ scenes: [...state.scenes, scene] }))
      syncToIdbFireAndForget('scene', scene)
    },

    // ── Codex ──

    setCodexSearchQuery: (q) => set({ codexSearchQuery: q }),

    fetchCodexEntries: async (projectId: string) => {
      set({ codexLoading: true })
      try {
        const resp = await fetch(`/api/plugins/codex/${projectId}`)
        if (resp.ok) {
          const data = await resp.json()
          const incoming: unknown[] = Array.isArray(data.entries)
            ? data.entries
            : []
          const prevMap = new Map(
            get().codexEntries.map((e) => [e.entry_id, e] as const),
          )
          const merged = incoming
            .filter(
              (e: unknown): e is CodexEntry =>
                !!e && typeof e === 'object',
            )
            .map((entry) => {
              const prev = prevMap.get(entry.entry_id)
              return {
                ...entry,
                _isNew: prev?._isNew === true,
                _newAt: prev?._newAt,
              }
            })
          set({ codexEntries: merged, codexLoading: false })
        } else {
          set({ codexLoading: false })
        }
      } catch {
        set({ codexLoading: false })
      }
    },

    addCodexEntry: (entry: CodexEntry) => {
      const entries = get().codexEntries
      const idx = entries.findIndex((e) => e.entry_id === entry.entry_id)
      const tagged = { ...entry, _isNew: true, _newAt: Date.now() }
      if (idx >= 0) {
        const updated = [...entries]
        updated[idx] = tagged
        set({ codexEntries: updated })
      } else {
        set({ codexEntries: [...entries, tagged] })
      }
    },

    markEntrySeen: (entryId: string) => {
      if (!entryId) return
      set({
        codexEntries: get().codexEntries.map((e) =>
          e.entry_id === entryId
            ? { ...e, _isNew: false, _newAt: undefined }
            : e,
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
        codexEntries: get().codexEntries.map((e) =>
          ids.has(e.entry_id)
            ? { ...e, _isNew: false, _newAt: undefined }
            : e,
        ),
      })
    },

    clearNewFlags: () => {
      set({
        codexEntries: get().codexEntries.map((e) => ({
          ...e,
          _isNew: false,
          _newAt: undefined,
        })),
      })
    },

    // ── Reset ──

    reset: () => set(INITIAL_STATE),
  }),
)
