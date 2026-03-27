import assert from 'node:assert/strict'
import test from 'node:test'
import type { GameEvent } from '../src/types'
import { buildEventForest } from '../src/components/status/eventTree.js'

function makeEvent(partial: Partial<GameEvent> & Pick<GameEvent, 'id' | 'name'>): GameEvent {
  return {
    id: partial.id,
    session_id: partial.session_id || 's1',
    event_type: partial.event_type || 'quest',
    name: partial.name,
    description: partial.description || '',
    status: partial.status || 'active',
    parent_event_id: partial.parent_event_id,
    source: partial.source || 'dm',
    visibility: partial.visibility || 'known',
    created_at: partial.created_at || '2026-02-17T00:00:00.000Z',
    updated_at: partial.updated_at || '2026-02-17T00:00:00.000Z',
    children: partial.children,
  }
}

test('event tree supports deep hierarchy and orders by created_at', () => {
  const events = [
    makeEvent({ id: 'e1', name: 'root', created_at: '2026-02-17T00:00:01.000Z' }),
    makeEvent({ id: 'e3', name: 'child-b', parent_event_id: 'e1', created_at: '2026-02-17T00:00:03.000Z' }),
    makeEvent({ id: 'e2', name: 'child-a', parent_event_id: 'e1', created_at: '2026-02-17T00:00:02.000Z' }),
    makeEvent({ id: 'e4', name: 'grandchild', parent_event_id: 'e2', created_at: '2026-02-17T00:00:04.000Z' }),
  ]

  const forest = buildEventForest(events)
  assert.equal(forest.length, 1)
  assert.equal(forest[0].id, 'e1')
  assert.deepEqual(forest[0].children?.map((x) => x.id), ['e2', 'e3'])
  assert.equal(forest[0].children?.[0].children?.[0].id, 'e4')
})

test('event tree guards cycles by promoting cyclic nodes to roots', () => {
  const events = [
    makeEvent({ id: 'a', name: 'A', parent_event_id: 'b' }),
    makeEvent({ id: 'b', name: 'B', parent_event_id: 'a' }),
  ]
  const forest = buildEventForest(events)
  const ids = forest.map((e) => e.id).sort()
  assert.deepEqual(ids, ['a', 'b'])
})
