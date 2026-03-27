import { useCallback, useEffect, useState } from 'react'
import type { ArchiveVersion, Session } from '../types'
import { useSessionStore } from '../stores/sessionStore'
import { useGameDataStore } from '../stores/gameDataStore'
import { useProjectStore } from '../stores/projectStore'
import * as api from '../services/api'
import * as gameStorage from '../services/gameStorage'

export function useArchive(currentSession: Session | null) {
  const [archiveVersions, setArchiveVersions] = useState<ArchiveVersion[]>([])
  const [archiveBusy, setArchiveBusy] = useState(false)
  const [showRestoreModal, setShowRestoreModal] = useState(false)

  const {
    addMessage,
    fetchMessages,
    fetchSessions,
    setPhase,
    switchSession,
  } = useSessionStore()
  const { setScenes, setCurrentScene, setCharacters, setWorldState, setEvents } = useGameDataStore()
  const currentProject = useProjectStore((s) => s.currentProject)

  const refreshArchiveVersions = useCallback(() => {
    if (!currentSession) {
      setArchiveVersions([])
      return
    }
    api.getArchiveVersions(currentSession.id).then(setArchiveVersions).catch((err) => { console.warn('[useArchive] failed to fetch versions:', err); setArchiveVersions([]) })
  }, [currentSession])

  useEffect(() => {
    refreshArchiveVersions()
  }, [refreshArchiveVersions])

  const handleArchiveNow = useCallback(async () => {
    if (!currentSession || archiveBusy) return
    setArchiveBusy(true)
    try {
      const created = await api.summarizeArchive(currentSession.id, 'manual')
      await refreshArchiveVersions()
      addMessage({
        id: crypto.randomUUID(),
        session_id: currentSession.id,
        role: 'system',
        content: `已生成存档版本 v${created.version}`,
        message_type: 'system_event',
        created_at: new Date().toISOString(),
      })
    } catch {
      addMessage({
        id: crypto.randomUUID(),
        session_id: currentSession.id,
        role: 'system',
        content: '手动存档失败',
        message_type: 'system_event',
        created_at: new Date().toISOString(),
      })
    } finally {
      setArchiveBusy(false)
    }
  }, [currentSession, archiveBusy, refreshArchiveVersions, addMessage])

  const handleRestoreArchive = useCallback(async () => {
    if (!currentSession || archiveBusy) return

    let versions = archiveVersions
    if (versions.length === 0) {
      try {
        versions = await api.getArchiveVersions(currentSession.id)
        setArchiveVersions(versions)
      } catch {
        versions = []
      }
    }

    if (versions.length === 0) {
      addMessage({
        id: crypto.randomUUID(),
        session_id: currentSession.id,
        role: 'system',
        content: '当前没有可恢复的存档版本',
        message_type: 'system_event',
        created_at: new Date().toISOString(),
      })
      return
    }

    setShowRestoreModal(true)
  }, [currentSession, archiveBusy, archiveVersions, addMessage])

  const handleRestoreVersion = useCallback(async (version: number, mode: 'hard' | 'fork') => {
    if (!currentSession) return
    setShowRestoreModal(false)
    setArchiveBusy(true)
    try {
      const restored = await api.restoreArchiveVersion(currentSession.id, version, mode)
      let targetSessionId = restored.session_id || currentSession.id

      if (restored.mode === 'fork' && restored.new_session_id && currentProject?.id) {
        await fetchSessions(currentProject.id)
        const forkSession = useSessionStore
          .getState()
          .sessions.find((s) => s.id === restored.new_session_id)
        if (forkSession) {
          await switchSession(forkSession)
          targetSessionId = forkSession.id
        } else {
          targetSessionId = restored.new_session_id
        }
      }

      await fetchMessages(targetSessionId)
      const [loadedScenes, loadedEvents, loadedVersions, loadedCharacters, loadedState] = await Promise.all([
        gameStorage.fetchScenes(targetSessionId),
        gameStorage.fetchEvents(targetSessionId),
        api.getArchiveVersions(targetSessionId),
        gameStorage.fetchCharacters(targetSessionId),
        api.getSessionState(targetSessionId),
      ])
      setScenes(loadedScenes)
      setCurrentScene(loadedScenes.find((s) => s.is_current) ?? null)
      setEvents(loadedEvents)
      setArchiveVersions(loadedVersions)
      setCharacters(loadedCharacters)
      setWorldState(loadedState.world || {})
      setPhase(restored.phase || 'playing')
    } catch {
      addMessage({
        id: crypto.randomUUID(),
        session_id: currentSession.id,
        role: 'system',
        content: `恢复存档 v${version} 失败`,
        message_type: 'system_event',
        created_at: new Date().toISOString(),
      })
    } finally {
      setArchiveBusy(false)
    }
  }, [
    currentSession,
    addMessage,
    fetchMessages,
    fetchSessions,
    setScenes,
    setCurrentScene,
    setEvents,
    setCharacters,
    setWorldState,
    setPhase,
    switchSession,
    currentProject?.id,
  ])

  return {
    archiveVersions,
    archiveBusy,
    showRestoreModal,
    setShowRestoreModal,
    handleArchiveNow,
    handleRestoreArchive,
    handleRestoreVersion,
    refreshArchiveVersions,
  }
}
