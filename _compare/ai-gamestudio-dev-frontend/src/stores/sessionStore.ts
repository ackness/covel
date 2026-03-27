import { create } from 'zustand'
import type { Session, Message } from '../types'
import * as api from '../services/api'
import { StorageFactory } from '../services/settingsStorage'
import { idbGetSessions } from '../services/localDb'
import { syncToIdb, syncToIdbFireAndForget } from '../services/idbSync'
import { validateIdbRows } from '../utils/idbValidation'
import { attachPendingBlocksForTurn, type TurnPendingBlock } from './sessionTurnUtils'
import { useProjectStore } from './projectStore'
import { useTokenStore } from './tokenStore'
import { useGameDataStore } from './gameDataStore'
import { useMessageImageStore } from './messageImageStore'
import * as gameStorage from '../services/gameStorage'

export type PendingBlock = TurnPendingBlock

export type StreamStatus = 'idle' | 'waiting' | 'streaming' | 'done' | 'error'

interface SessionStore {
  sessions: Session[]
  currentSession: Session | null
  messages: Message[]
  isStreaming: boolean
  streamingContent: string
  streamStatus: StreamStatus
  pendingBlocks: PendingBlock[]
  phase: string
  pluginProcessing: boolean
  pluginProgress: { round: number; tool_calls: string[]; blocks_so_far: string[] } | null
  lastPluginSummary: { rounds: number; tool_calls: string[]; blocks_emitted: string[] } | null
  fetchSessions: (projectId: string) => Promise<void>
  createSession: (projectId: string) => Promise<Session>
  switchSession: (session: Session) => Promise<void>
  deleteSession: (sessionId: string) => Promise<void>
  setCurrentSession: (session: Session | null) => void
  fetchMessages: (sessionId: string) => Promise<void>
  addMessage: (message: Message) => void
  setStreaming: (streaming: boolean) => void
  setStreamStatus: (status: StreamStatus) => void
  appendStreamContent: (content: string) => void
  clearStreamContent: () => void
  addPendingBlock: (block: PendingBlock) => void
  flushPendingBlocksForTurn: (turnId: string) => void
  clearPendingBlocks: () => void
  setPhase: (phase: string) => void
  setPluginProcessing: (processing: boolean) => void
  setPluginProgress: (progress: { round: number; tool_calls: string[]; blocks_so_far: string[] } | null) => void
  setLastPluginSummary: (summary: { rounds: number; tool_calls: string[]; blocks_emitted: string[] } | null) => void
  removeLastAssistantMessage: () => void
  deleteMessage: (messageId: string) => void
  deleteMessagesFrom: (messageId: string) => void
  updateBlockData: (blockId: string, data: unknown) => void
  updateMessageBlocks: (
    messageId: string,
    blocks: {
      type: string
      data: unknown
      block_id?: string
      output?: import('../services/outputContract').OutputEnvelope
    }[],
  ) => void
}

export const useSessionStore = create<SessionStore>((set) => ({
  sessions: [],
  currentSession: null,
  messages: [],
  isStreaming: false,
  streamingContent: '',
  streamStatus: 'idle' as StreamStatus,
  pendingBlocks: [],
  phase: 'init',
  pluginProcessing: false,
  pluginProgress: null,
  lastPluginSummary: null,

  fetchSessions: async (projectId) => {
    try {
      const persistent = await StorageFactory.isStoragePersistent()
      if (!persistent) {
        const rows = await idbGetSessions(projectId)
        set({ sessions: validateIdbRows<Session>(rows, ['id', 'project_id']) })
      } else {
        const sessions = await api.getSessions(projectId)
        set({ sessions })
      }
    } catch {
      // ignore
    }
  },

  createSession: async (projectId) => {
    try {
      const persistent = await StorageFactory.isStoragePersistent()

      if (!persistent) {
        // Ephemeral backend (Vercel + SQLite): ensure project exists in backend first,
        // then create the session there so the chat endpoint can find it.
        const project = useProjectStore.getState().currentProject
        if (project) {
          await useProjectStore.getState().syncProjectToBackend(project)
        }
      }

      const session = await api.createSession(projectId)

      if (!persistent) {
        await syncToIdb('session', session)
      }

      set((state) => ({
        sessions: [...state.sessions, session],
        currentSession: session,
        messages: [],
        pendingBlocks: [],
        phase: 'init',
        streamingContent: '',
        streamStatus: 'idle' as StreamStatus,
        isStreaming: false,
      }))
      useGameDataStore.getState().reset()
      useMessageImageStore.getState().resetMessageImages()
      useTokenStore.getState().reset()
      return session
    } catch (err) {
      console.error('Failed to create session:', err)
      throw err
    }
  },

  setCurrentSession: (session) => set({ currentSession: session }),

  switchSession: async (session) => {
    set({
      currentSession: session,
      messages: [],
      pendingBlocks: [],
      phase: session.phase || 'init',
      streamingContent: '',
      streamStatus: 'idle' as StreamStatus,
      isStreaming: false,
    })
    useGameDataStore.getState().reset()
    useMessageImageStore.getState().resetMessageImages()
    useTokenStore.getState().reset()
    try {
      const messages = await gameStorage.fetchMessages(session.id)
      set({ messages })
    } catch {
      // ignore
    }
  },

  deleteSession: async (sessionId) => {
    try {
      const persistent = await StorageFactory.isStoragePersistent()
      await api.deleteSession(sessionId)
      if (!persistent) {
        await syncToIdb('deleteSession', { id: sessionId })
      }
      set((state) => {
        const sessions = state.sessions.filter((s) => s.id !== sessionId)
        const isCurrent = state.currentSession?.id === sessionId
        if (isCurrent) {
          useGameDataStore.getState().reset()
          useMessageImageStore.getState().resetMessageImages()
          return {
            sessions,
            currentSession: null,
            messages: [],
            pendingBlocks: [],
            phase: 'init',
            streamingContent: '',
            streamStatus: 'idle' as StreamStatus,
            isStreaming: false,
          }
        }
        return { sessions }
      })
      useTokenStore.getState().reset()
    } catch (err) {
      console.error('Failed to delete session:', err)
      throw err
    }
  },

  fetchMessages: async (sessionId) => {
    try {
      const messages = await gameStorage.fetchMessages(sessionId)
      set({ messages })
    } catch {
      // ignore
    }
  },

  addMessage: (message) => {
    set((state) => ({ messages: [...state.messages, message] }))
    syncToIdbFireAndForget('message', message)
  },

  setStreaming: (isStreaming) => set({ isStreaming }),

  setStreamStatus: (streamStatus) => set({ streamStatus }),

  appendStreamContent: (content) =>
    set((state) => ({ streamingContent: state.streamingContent + content })),

  clearStreamContent: () => set({ streamingContent: '' }),

  addPendingBlock: (block) =>
    set((state) => ({ pendingBlocks: [...state.pendingBlocks, block] })),

  flushPendingBlocksForTurn: (turnId) =>
    set((state) => {
      const merged = attachPendingBlocksForTurn(
        state.messages,
        state.pendingBlocks,
        turnId,
      )
      if (
        merged.messages === state.messages
        && merged.pendingBlocks === state.pendingBlocks
      ) {
        return state
      }
      return { messages: merged.messages, pendingBlocks: merged.pendingBlocks }
    }),

  clearPendingBlocks: () => set({ pendingBlocks: [] }),

  setPhase: (phase) => set({ phase }),

  setPluginProcessing: (pluginProcessing) => set({ pluginProcessing, ...(pluginProcessing ? {} : { pluginProgress: null }) }),
  setPluginProgress: (pluginProgress) => set({ pluginProgress }),

  setLastPluginSummary: (lastPluginSummary) => set({ lastPluginSummary }),

  removeLastAssistantMessage: () =>
    set((state) => {
      const msgs = [...state.messages]
      for (let i = msgs.length - 1; i >= 0; i--) {
        if (msgs[i].role === 'assistant') {
          msgs.splice(i, 1)
          return { messages: msgs, pendingBlocks: [] }
        }
      }
      return state
    }),

  deleteMessage: (messageId) =>
    set((state) => ({
      messages: state.messages.filter((m) => m.id !== messageId),
    })),

  deleteMessagesFrom: (messageId) =>
    set((state) => {
      const idx = state.messages.findIndex((m) => m.id === messageId)
      if (idx < 0) return state
      return { messages: state.messages.slice(0, idx), pendingBlocks: [] }
    }),

  updateBlockData: (blockId, data) =>
    set((state) => {
      // Update block in messages (already flushed blocks)
      let found = false
      const nextMessages = state.messages.map((msg) => {
        if (!msg.blocks) return msg
        const updatedBlocks = msg.blocks.map((b) => {
          if (b.block_id === blockId) {
            found = true
            if (b.output && typeof b.output === 'object') {
              return { ...b, data, output: { ...b.output, data } }
            }
            return { ...b, data }
          }
          return b
        })
        return found ? { ...msg, blocks: updatedBlocks } : msg
      })
      if (found) return { messages: nextMessages }

      // Update block in pendingBlocks (not yet flushed)
      const nextPending = state.pendingBlocks.map((b) => {
        if (b.blockId === blockId) {
          found = true
          if (b.output && typeof b.output === 'object') {
            return { ...b, data, output: { ...b.output, data } }
          }
          return { ...b, data }
        }
        return b
      })
      if (found) return { pendingBlocks: nextPending }

      return state
    }),

  updateMessageBlocks: (messageId, blocks) =>
    set((state) => ({
      messages: state.messages.map((msg) =>
        msg.id === messageId ? { ...msg, blocks } : msg,
      ),
    })),
}))
