import { useCallback, useRef } from 'react'
import type { Session } from '../types'
import type { GameWebSocket, StructuredMessage } from '../services/websocket'
import { useSessionStore } from '../stores/sessionStore'
import { useUiStore } from '../stores/uiStore'

export function useGameActions(
  currentSession: Session | null,
  wsRef: React.RefObject<GameWebSocket | null>,
  clearInitError: () => void,
) {
  const language = useUiStore((s) => s.language)
  const lastActionRef = useRef<{ type: string; content?: string; data?: unknown } | null>(null)

  const {
    addMessage,
    setStreaming,
    setStreamStatus,
    clearStreamContent,
    clearPendingBlocks,
    isStreaming,
  } = useSessionStore()

  const handleSend = useCallback(
    (message: string) => {
      if (!currentSession || !wsRef.current) return
      if (useSessionStore.getState().isStreaming) return

      try {
        const parsed = JSON.parse(message)
        if (parsed.type && typeof parsed.type === 'string' && parsed.type !== 'message') {
          lastActionRef.current = { type: 'structured', data: parsed }
          wsRef.current.send(parsed)
          setStreaming(true)
          setStreamStatus('waiting')
          clearStreamContent()
          return
        }
      } catch {
        // Not JSON
      }

      if (useSessionStore.getState().pendingBlocks.length > 0) {
        clearPendingBlocks()
      }

      lastActionRef.current = { type: 'message', content: message }

      addMessage({
        id: crypto.randomUUID(),
        session_id: currentSession.id,
        role: 'user',
        content: message,
        message_type: 'chat',
        created_at: new Date().toISOString(),
      })

      setStreaming(true)
      setStreamStatus('waiting')
      clearStreamContent()
      wsRef.current.sendMessage(message, language)
    },
    [currentSession, wsRef, addMessage, setStreaming, setStreamStatus, clearStreamContent, clearPendingBlocks, language],
  )

  const handleInitGame = useCallback(() => {
    if (!wsRef.current) return
    clearInitError()
    lastActionRef.current = { type: 'init_game' }
    setStreaming(true)
    setStreamStatus('waiting')
    clearStreamContent()
    wsRef.current.sendInitGame(undefined, language)
  }, [wsRef, setStreaming, setStreamStatus, clearStreamContent, clearInitError, language])

  const handleRetry = useCallback(() => {
    const last = lastActionRef.current
    if (!last || !wsRef.current) return

    useSessionStore.getState().removeLastAssistantMessage()
    setStreamStatus('idle')

    if (last.type === 'init_game') {
      handleInitGame()
    } else if (last.type === 'message' && last.content) {
      setStreaming(true)
      setStreamStatus('waiting')
      clearStreamContent()
      wsRef.current.sendMessage(last.content, language)
    } else if (last.type === 'structured' && last.data) {
      setStreaming(true)
      setStreamStatus('waiting')
      clearStreamContent()
      wsRef.current.send(last.data as StructuredMessage)
    }
  }, [wsRef, handleInitGame, setStreaming, setStreamStatus, clearStreamContent, language])

  const handleForceTrigger = useCallback(
    (blockType: string) => {
      if (!wsRef.current || isStreaming) return
      setStreaming(true)
      setStreamStatus('waiting')
      clearStreamContent()
      wsRef.current.sendForceTrigger(blockType, {
        lang: language,
        source: 'quick_actions',
      })
    },
    [wsRef, isStreaming, setStreaming, setStreamStatus, clearStreamContent, language],
  )

  const handleGenerateImage = useCallback(
    (messageId: string) => {
      if (!wsRef.current || isStreaming) return
      wsRef.current.sendGenerateMessageImage(messageId)
    },
    [wsRef, isStreaming],
  )

  const handleSceneSwitch = useCallback(
    (sceneId: string) => {
      if (!wsRef.current) return
      wsRef.current.sendSceneSwitch(sceneId)
    },
    [wsRef],
  )

  const handleRetriggerPlugins = useCallback(
    (messageId: string) => {
      if (!wsRef.current || isStreaming) return
      wsRef.current.sendRetriggerPlugins(messageId)
    },
    [wsRef, isStreaming],
  )

  return {
    handleSend,
    handleInitGame,
    handleRetry,
    handleForceTrigger,
    handleGenerateImage,
    handleSceneSwitch,
    handleRetriggerPlugins,
  }
}
