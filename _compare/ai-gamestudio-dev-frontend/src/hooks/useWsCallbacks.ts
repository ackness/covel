import { useCallback } from 'react'
import type { Character, GameEvent, StoryImageData, Scene } from '../types'
import { useSessionStore } from '../stores/sessionStore'
import { useMessageImageStore } from '../stores/messageImageStore'
import { useGameDataStore } from '../stores/gameDataStore'
import { useNotificationStore } from '../stores/notificationStore'
import { useTokenStore } from '../stores/tokenStore'
import * as api from '../services/api'
import * as gameStorage from '../services/gameStorage'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isGameEvent(value: unknown): value is GameEvent {
  if (!isRecord(value)) return false
  return (
    typeof value.id === 'string' &&
    typeof value.session_id === 'string' &&
    typeof value.event_type === 'string' &&
    typeof value.name === 'string' &&
    typeof value.description === 'string' &&
    typeof value.status === 'string' &&
    typeof value.source === 'string' &&
    typeof value.visibility === 'string'
  )
}

export interface WsCallbacks {
  onChunk: (content: string) => void
  onDone: (fullContent: string, turnId: string | null, hasBlocks: boolean, messageId: string | null, rawContent: string | null) => void
  onStateUpdate: (state: Record<string, unknown>) => void
  onPluginSummary: (data: unknown) => void
  onPluginProgress: (data: unknown) => void
  onPhaseChange: (newPhase: string) => void
  onSceneUpdate: (data: Record<string, unknown>, sessionId: string) => void
  onNotification: (data: Record<string, unknown>, turnId: string | null, blockId: string | null, sessionId: string) => void
  onBlock: (type: string, data: unknown, turnId: string | null, blockId: string | null, output: unknown) => void
  onMessageBlocksUpdated: (messageId: string | null, blocks: unknown) => void
  onTurnEnd: (turnId: string | null) => void
  onMessageImage: (messageId: string, imageData: unknown) => void
  onMessageImageLoading: (messageId: string) => void
  onTokenUsage: (data: Record<string, unknown>) => void
  onError: (error: string, sessionId: string, setInitError: (e: string) => void) => void
}

/**
 * Builds stable WebSocket callback handlers using store actions.
 * All callbacks are wrapped in useCallback for referential stability.
 */
export function useWsCallbacks(sessionId: string): WsCallbacks {
  const {
    addMessage,
    setStreaming,
    setStreamStatus,
    appendStreamContent,
    clearStreamContent,
    addPendingBlock,
    setPhase,
    setPluginProcessing,
    setPluginProgress,
    setLastPluginSummary,
    flushPendingBlocksForTurn,
    updateMessageBlocks,
  } = useSessionStore()
  const { setCurrentScene, setScenes, setCharacters, mergeCharacters, setWorldState, addEvent, setEvents, upsertQuest, addCodexEntry } = useGameDataStore()
  const { setMessageImage, setImageLoading } = useMessageImageStore()

  const onChunk = useCallback((content: string) => {
    setStreamStatus('streaming')
    appendStreamContent(content)
  }, [setStreamStatus, appendStreamContent])

  const onDone = useCallback((
    fullContent: string,
    turnId: string | null,
    hasBlocks: boolean,
    messageId: string | null,
    rawContent: string | null,
  ) => {
    setStreaming(false)
    setStreamStatus('done')
    if (fullContent || hasBlocks) {
      addMessage({
        id: messageId || crypto.randomUUID(),
        session_id: sessionId,
        role: 'assistant',
        content: fullContent || '',
        raw_content: rawContent || undefined,
        turn_id: turnId || undefined,
        message_type: 'narration',
        created_at: new Date().toISOString(),
      })
    }
    clearStreamContent()
    setTimeout(() => setStreamStatus('idle'), 3000)
  }, [sessionId, setStreaming, setStreamStatus, addMessage, clearStreamContent])

  const onStateUpdate = useCallback((state: Record<string, unknown>) => {
    const characters = state?.characters
    if (Array.isArray(characters)) mergeCharacters(characters as Character[])
    const world = state?.world
    if (isRecord(world)) setWorldState(world)
  }, [mergeCharacters, setWorldState])

  const onPluginSummary = useCallback((data: unknown) => {
    setLastPluginSummary(data as { rounds: number; tool_calls: string[]; blocks_emitted: string[] } | null)
  }, [setLastPluginSummary])

  const onPluginProgress = useCallback((data: unknown) => {
    setPluginProgress(data as { round: number; tool_calls: string[]; blocks_so_far: string[] } | null)
  }, [setPluginProgress])

  const onPhaseChange = useCallback((newPhase: string) => {
    if (newPhase === 'plugins') {
      setPluginProcessing(true)
      setLastPluginSummary(null)
      return
    }
    if (newPhase === 'complete') {
      setPluginProcessing(false)
      return
    }

    setPhase(newPhase)
    if ((newPhase === 'playing' || newPhase === 'character_creation') && sessionId) {
      gameStorage.fetchScenes(sessionId).then(setScenes).catch((err) => console.warn('[ws] fetchScenes', err))
      gameStorage.fetchEvents(sessionId).then(setEvents).catch((err) => console.warn('[ws] fetchEvents', err))
      gameStorage.fetchCharacters(sessionId).then(setCharacters).catch((err) => console.warn('[ws] fetchCharacters', err))
      api.getSessionState(sessionId).then((state) => setWorldState(state.world || {})).catch((err) => console.warn('[ws] getSessionState', err))
    } else if (newPhase === 'init') {
      setScenes([])
      setCurrentScene(null)
      setEvents([])
      setCharacters([])
      setWorldState({})
    }
  }, [sessionId, setPhase, setPluginProcessing, setLastPluginSummary, setScenes, setEvents, setCharacters, setCurrentScene, setWorldState])

  const onSceneUpdate = useCallback((data: Record<string, unknown>, sid: string) => {
    const sceneId = typeof data.scene_id === 'string' ? data.scene_id : ''
    const sceneName = typeof data.name === 'string' ? data.name : ''
    if (!sceneId || !sceneName) return

    const description = typeof data.description === 'string' ? data.description : undefined
    const npcs = Array.isArray(data.npcs) ? data.npcs : undefined
    const scene: Scene = {
      id: sceneId,
      session_id: sid,
      name: sceneName,
      description,
      is_current: true,
      metadata: npcs ? { npcs } : undefined,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }

    setCurrentScene(scene)
    const existing = useGameDataStore.getState().scenes
    const updated = existing.map((s) => (s.id === scene.id ? scene : { ...s, is_current: false }))
    const found = existing.find((s) => s.id === scene.id)
    if (found) {
      setScenes(updated)
    } else {
      setScenes([...updated.map((s) => ({ ...s, is_current: false })), scene])
    }
    gameStorage.fetchCharacters(sid).then(setCharacters).catch((err) => console.warn('[ws] fetchCharacters', err))
    api.getSessionState(sid).then((state) => setWorldState(state.world || {})).catch((err) => console.warn('[ws] getSessionState', err))
  }, [setCurrentScene, setScenes, setCharacters, setWorldState])

  const onNotification = useCallback((
    data: Record<string, unknown>,
    turnId: string | null,
    blockId: string | null,
    sid: string,
  ) => {
    useNotificationStore.getState().addLiveNotification(
      sid,
      {
        level: typeof data.level === 'string' ? data.level : undefined,
        title: typeof data.title === 'string' ? data.title : undefined,
        content: typeof data.content === 'string' ? data.content : undefined,
      },
      { id: blockId || undefined, turnId: turnId || undefined },
    )
  }, [])

  const onBlock = useCallback((
    type: string,
    data: unknown,
    turnId: string | null,
    blockId: string | null,
    output: unknown,
  ) => {
    if (type === 'state_update') return
    if (type === 'scene_update') return
    if (type === 'character_confirmed') return
    if (type === 'event') {
      if (isGameEvent(data)) addEvent(data)
      return
    }
    if (type === 'quest_update' && data && isRecord(data)) {
      const q = data as { quest_id?: string; title?: string; status?: string; description?: string; objectives?: unknown[]; rewards?: unknown }
      if (q.quest_id && q.title && q.status) {
        upsertQuest(q as import('../types').Quest)
      }
    }
    if (type === 'codex_entry' && data) {
      addCodexEntry(data as import('../stores/gameDataStore').CodexEntry)
    }
    const enrichedData =
      data && typeof data === 'object' && !Array.isArray(data)
        ? { ...(data as Record<string, unknown>), _block_type: type }
        : data
    const resolvedBlockId = blockId || `${turnId || 'turnless'}:${crypto.randomUUID()}`

    if (blockId) {
      const state = useSessionStore.getState()
      const existsInMessages = state.messages.some(
        (m) => m.blocks?.some((b) => b.block_id === blockId),
      )
      const existsInPending = state.pendingBlocks.some((b) => b.blockId === blockId)
      if (existsInMessages || existsInPending) {
        state.updateBlockData(blockId, enrichedData)
        return
      }
    }

    addPendingBlock({
      type,
      data: enrichedData,
      output: output || undefined,
      turnId: turnId || undefined,
      blockId: resolvedBlockId,
    })
  }, [addEvent, addPendingBlock, upsertQuest, addCodexEntry])

  const onMessageBlocksUpdated = useCallback((messageId: string | null, blocks: unknown) => {
    if (messageId && Array.isArray(blocks)) updateMessageBlocks(messageId, blocks as { type: string; data: unknown; block_id?: string; output?: import('../services/outputContract').OutputEnvelope }[])
  }, [updateMessageBlocks])

  const onTurnEnd = useCallback((turnId: string | null) => {
    if (!turnId) return
    flushPendingBlocksForTurn(turnId)
  }, [flushPendingBlocksForTurn])

  const onMessageImage = useCallback((messageId: string, imageData: unknown) => {
    setImageLoading(messageId, false)
    if (imageData && (imageData as Record<string, unknown>).status !== 'error') {
      setMessageImage(messageId, imageData as StoryImageData)
    }
  }, [setImageLoading, setMessageImage])

  const onMessageImageLoading = useCallback((messageId: string) => {
    setImageLoading(messageId, true)
  }, [setImageLoading])

  const onTokenUsage = useCallback((data: Record<string, unknown>) => {
    useTokenStore.getState().updateUsage({
      promptTokens: Number(data.prompt_tokens || 0),
      completionTokens: Number(data.completion_tokens || 0),
      totalTokens: Number(data.total_tokens || 0),
      turnCost: Number(data.turn_cost || 0),
      totalCost: Number(data.total_cost || 0),
      totalPromptTokens: Number(data.total_prompt_tokens || 0),
      totalCompletionTokens: Number(data.total_completion_tokens || 0),
      contextUsage: Number(data.context_usage || 0),
      maxInputTokens: Number(data.max_input_tokens || 0),
      model: String(data.model || ''),
    })
  }, [])

  const onError = useCallback((error: string, sid: string, setErr: (e: string) => void) => {
    setStreaming(false)
    setStreamStatus('error')
    clearStreamContent()
    if (useSessionStore.getState().phase === 'init') {
      setErr(error)
    }
    addMessage({
      id: crypto.randomUUID(),
      session_id: sid,
      role: 'system',
      content: `Error: ${error}`,
      message_type: 'system_event',
      created_at: new Date().toISOString(),
    })
  }, [setStreaming, setStreamStatus, clearStreamContent, addMessage])

  return {
    onChunk,
    onDone,
    onStateUpdate,
    onPluginSummary,
    onPluginProgress,
    onPhaseChange,
    onSceneUpdate,
    onNotification,
    onBlock,
    onMessageBlocksUpdated,
    onTurnEnd,
    onMessageImage,
    onMessageImageLoading,
    onTokenUsage,
    onError,
  }
}
