import assert from 'node:assert/strict'
import test from 'node:test'
import type { Session } from '../src/types'
import { decideSessionBootstrap } from '../src/utils/sessionBootstrap.js'

function makeSession(id: string, phase: Session['phase']): Session {
  return {
    id,
    project_id: 'project-1',
    status: 'active',
    phase,
    created_at: '2026-02-17T00:00:00.000Z',
  }
}

test('session bootstrap reuses init session and does not create a new one', () => {
  const decision = decideSessionBootstrap({
    projectId: 'project-1',
    loading: false,
    autoCreating: false,
    sessionsFetched: true,
    checked: false,
    sessions: [makeSession('init-1', 'init')],
    currentSession: null,
  })

  assert.equal(decision.reuseSession?.id, 'init-1')
  assert.equal(decision.shouldCreate, false)
})

test('session bootstrap does not duplicate creation after first check', () => {
  const decision = decideSessionBootstrap({
    projectId: 'project-1',
    loading: false,
    autoCreating: false,
    sessionsFetched: true,
    checked: true,
    sessions: [],
    currentSession: null,
  })

  assert.equal(decision.reuseSession, null)
  assert.equal(decision.shouldCreate, false)
})
