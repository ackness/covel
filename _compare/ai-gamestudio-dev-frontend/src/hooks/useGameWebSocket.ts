import { useEffect, useRef, useState } from 'react'
import type { Session } from '../types'
import { useProjectStore } from '../stores/projectStore'
import { useBlockInteractionStore } from '../stores/blockInteractionStore'
import { useNotificationStore } from '../stores/notificationStore'
import { useSessionStore } from '../stores/sessionStore'
import { useGameDataStore } from '../stores/gameDataStore'
import { GameWebSocket } from '../services/websocket'
import { StorageFactory } from '../services/settingsStorage'
import { useUiStore } from '../stores/uiStore'
import {
  buildBrowserImageOverrides,
  buildBrowserLlmOverrides,
} from '../utils/browserLlmConfig'
import { useSessionHydration } from './useSessionHydration'
import { useWsCallbacks } from './useWsCallbacks'

export function useGameWebSocket(currentSession: Session | null) {
  const wsRef = useRef<GameWebSocket | null>(null)
  const [wsStatus, setWsStatus] = useState<'connected' | 'reconnecting' | 'disconnected'>('connected')
  const [initError, setInitError] = useState<string | null>(null)

  const { setStreaming, setStreamStatus, clearStreamContent } = useSessionStore()
  const { setCharacters, setWorldState, setEvents } = useGameDataStore()

  // Hydrate session data (characters, world state, scenes, events, images)
  useSessionHydration(currentSession)

  // Build stable WS callback handlers
  const cbs = useWsCallbacks(currentSession?.id ?? '')

  useEffect(() => {
    if (!currentSession) return

    useBlockInteractionStore.getState().clear()
    useNotificationStore.getState().resetForSession(currentSession.id)

    setCharacters([])
    setEvents([])
    setWorldState({})

    const ws = new GameWebSocket()
    ws.setLlmOverrideResolver(() => {
      const projectId = useProjectStore.getState().currentProject?.id ?? null
      return buildBrowserLlmOverrides(projectId)
    })
    ws.setImageOverrideResolver(() => {
      const projectId = useProjectStore.getState().currentProject?.id ?? null
      return buildBrowserImageOverrides(projectId)
    })
    wsRef.current = ws
    setWsStatus('connected')

    ws.onConnected = () => {
      setWsStatus('connected')
      StorageFactory.redetectIfNeeded().then((persistent) => {
        if (persistent) useUiStore.getState().checkStoragePersistence()
      }).catch((err) => console.warn('[ws] redetect storage', err))
    }
    ws.onReconnecting = () => setWsStatus('reconnecting')
    ws.onDisconnected = () => {
      setWsStatus('disconnected')
      setStreaming(false)
      setStreamStatus('error')
      clearStreamContent()
    }

    ws.onChunk = cbs.onChunk
    ws.onDone = cbs.onDone
    ws.onStateUpdate = cbs.onStateUpdate
    ws.onPluginSummary = cbs.onPluginSummary
    ws.onPluginProgress = cbs.onPluginProgress
    ws.onPhaseChange = cbs.onPhaseChange
    ws.onSceneUpdate = (data) => cbs.onSceneUpdate(data, currentSession.id)
    ws.onNotification = (data, turnId, blockId) => cbs.onNotification(data, turnId, blockId, currentSession.id)
    ws.onBlock = cbs.onBlock
    ws.onMessageBlocksUpdated = cbs.onMessageBlocksUpdated
    ws.onTurnEnd = cbs.onTurnEnd
    ws.onMessageImage = cbs.onMessageImage
    ws.onMessageImageLoading = cbs.onMessageImageLoading
    ws.onTokenUsage = cbs.onTokenUsage
    ws.onError = (error) => cbs.onError(error, currentSession.id, setInitError)

    const connectTimeout = setTimeout(() => ws.connect(currentSession.id), 100)

    return () => {
      clearTimeout(connectTimeout)
      ws.disconnect()
      wsRef.current = null
    }
    // cbs is a new object each render but its members are stable useCallback refs.
    // Listing currentSession.id is sufficient to re-run when the session changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentSession?.id])

  const clearInitError = () => setInitError(null)

  return { wsRef, wsStatus, initError, clearInitError }
}
