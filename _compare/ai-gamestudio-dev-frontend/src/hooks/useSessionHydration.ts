import { useEffect } from 'react'
import type { Session } from '../types'
import { useSessionStore } from '../stores/sessionStore'
import { useMessageImageStore } from '../stores/messageImageStore'
import { useGameDataStore } from '../stores/gameDataStore'
import { useTokenStore } from '../stores/tokenStore'
import * as api from '../services/api'
import * as gameStorage from '../services/gameStorage'

/**
 * Fetches initial session data (characters, world state, scenes, events, images)
 * when a session becomes active. Runs once per session ID change.
 */
export function useSessionHydration(currentSession: Session | null) {
  const { setPhase } = useSessionStore()
  const { hydrateMessageImages } = useMessageImageStore()
  const { setCharacters, setWorldState, setEvents, setScenes, setCurrentScene } = useGameDataStore()

  useEffect(() => {
    if (!currentSession) return

    gameStorage.fetchCharacters(currentSession.id).then(setCharacters).catch((err) => console.warn('[hydration] fetchCharacters', err))

    api.getSessionState(currentSession.id).then((state) => {
      setWorldState(state.world || {})
      const tu = state.token_usage
      if (tu && typeof tu === 'object' && (tu.total_prompt_tokens || tu.total_completion_tokens)) {
        useTokenStore.getState().updateUsage({
          promptTokens: 0,
          completionTokens: 0,
          totalTokens: 0,
          turnCost: 0,
          totalCost: Number(tu.total_cost || 0),
          totalPromptTokens: Number(tu.total_prompt_tokens || 0),
          totalCompletionTokens: Number(tu.total_completion_tokens || 0),
          contextUsage: 0,
          maxInputTokens: 0,
          model: '',
        })
      }
    }).catch((err) => console.warn('[hydration] getSessionState', err))

    hydrateMessageImages(currentSession.id)

    if (currentSession.phase === 'playing' || currentSession.phase === 'character_creation') {
      gameStorage.fetchScenes(currentSession.id).then((loaded) => {
        setScenes(loaded)
        const current = loaded.find((s) => s.is_current)
        if (current) setCurrentScene(current)
      }).catch((err) => console.warn('[hydration] fetchScenes', err))
      gameStorage.fetchEvents(currentSession.id).then(setEvents).catch((err) => console.warn('[hydration] fetchEvents', err))
    }

    if (currentSession.phase) setPhase(currentSession.phase)
  }, [currentSession?.id]) // eslint-disable-line react-hooks/exhaustive-deps
}
