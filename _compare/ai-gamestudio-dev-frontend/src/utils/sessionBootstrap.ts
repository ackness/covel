import type { Session } from '../types'

interface SessionBootstrapInput {
  projectId?: string
  loading: boolean
  autoCreating: boolean
  sessionsFetched: boolean
  checked: boolean
  sessions: Session[]
  currentSession: Session | null
}

interface SessionBootstrapDecision {
  reuseSession: Session | null
  shouldCreate: boolean
}

export function decideSessionBootstrap({
  projectId,
  loading,
  autoCreating,
  sessionsFetched,
  checked,
  sessions,
  currentSession,
}: SessionBootstrapInput): SessionBootstrapDecision {
  if (!projectId || loading || autoCreating || checked || !sessionsFetched) {
    return { reuseSession: null, shouldCreate: false }
  }

  const initSession = sessions.find((s) => s.phase === 'init')
  if (initSession && !currentSession) {
    return { reuseSession: initSession, shouldCreate: false }
  }

  if (sessions.length === 0) {
    return { reuseSession: null, shouldCreate: true }
  }

  return { reuseSession: null, shouldCreate: false }
}
