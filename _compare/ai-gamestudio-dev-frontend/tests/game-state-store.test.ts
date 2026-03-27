import assert from 'node:assert/strict'
import test from 'node:test'
import type { Character, GameEvent } from '../src/types'

// ---------------------------------------------------------------------------
// Pure reducer helpers — mirror the exact logic in gameStateStore.ts so we
// can test state transitions without importing Zustand or any side-effect
// modules (idbSync, sessionStore, localDb, etc.).
// ---------------------------------------------------------------------------

interface GameState {
  characters: Character[]
  worldState: Record<string, unknown>
  events: GameEvent[]
}

function initialState(): GameState {
  return { characters: [], worldState: {}, events: [] }
}

// setCharacters
function setCharacters(state: GameState, characters: Character[]): GameState {
  return { ...state, characters }
}

// updateCharacter
function updateCharacter(state: GameState, character: Character): GameState {
  return {
    ...state,
    characters: state.characters.map((c) => (c.id === character.id ? character : c)),
  }
}

// mergeCharacters
function mergeCharacters(state: GameState, incoming: Character[]): GameState {
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
  return { ...state, characters: Array.from(map.values()) }
}

// setWorldState
function setWorldState(state: GameState, worldState: Record<string, unknown>): GameState {
  return { ...state, worldState }
}

// setEvents
function setEvents(state: GameState, events: GameEvent[]): GameState {
  return { ...state, events }
}

// addEvent
function addEvent(state: GameState, event: GameEvent): GameState {
  return { ...state, events: [...state.events, event] }
}

// updateEvent
function updateEvent(state: GameState, event: GameEvent): GameState {
  return {
    ...state,
    events: state.events.map((e) => (e.id === event.id ? event : e)),
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeCharacter(id: string, name: string): Character {
  return {
    id,
    session_id: 'session-1',
    name,
    role: 'player',
    attributes: { hp: 10 },
    inventory: [],
  }
}

function makeEvent(id: string, name: string): GameEvent {
  return {
    id,
    session_id: 'session-1',
    event_type: 'quest',
    name,
    description: 'A test event.',
    status: 'active',
    source: 'system',
    visibility: 'public',
    created_at: '2026-02-25T00:00:00.000Z',
    updated_at: '2026-02-25T00:00:00.000Z',
  }
}

// ─── Initial state ────────────────────────────────────────────────────────────

test('initial state has empty characters, worldState, and events', () => {
  const s = initialState()
  assert.deepEqual(s.characters, [])
  assert.deepEqual(s.worldState, {})
  assert.deepEqual(s.events, [])
})

// ─── setCharacters ────────────────────────────────────────────────────────────

test('setCharacters replaces the characters list', () => {
  const chars = [makeCharacter('c1', 'Hero'), makeCharacter('c2', 'Mage')]
  const s = setCharacters(initialState(), chars)
  assert.deepEqual(s.characters, chars)
})

test('setCharacters with empty array clears existing characters', () => {
  let s = setCharacters(initialState(), [makeCharacter('c1', 'Hero')])
  s = setCharacters(s, [])
  assert.equal(s.characters.length, 0)
})

// ─── updateCharacter ──────────────────────────────────────────────────────────

test('updateCharacter replaces the matching character by id', () => {
  const original = makeCharacter('c1', 'Hero')
  let s = setCharacters(initialState(), [original, makeCharacter('c2', 'Mage')])
  s = updateCharacter(s, { ...original, attributes: { hp: 5 } })
  assert.deepEqual(s.characters[0].attributes, { hp: 5 })
})

test('updateCharacter leaves other characters unchanged', () => {
  const mage = makeCharacter('c2', 'Mage')
  let s = setCharacters(initialState(), [makeCharacter('c1', 'Hero'), mage])
  s = updateCharacter(s, { ...makeCharacter('c1', 'Hero'), attributes: { hp: 1 } })
  assert.deepEqual(s.characters[1], mage)
})

test('updateCharacter does not add a new character when id is not found', () => {
  let s = setCharacters(initialState(), [makeCharacter('c1', 'Hero')])
  s = updateCharacter(s, makeCharacter('c99', 'Ghost'))
  assert.equal(s.characters.length, 1)
})

// ─── mergeCharacters ──────────────────────────────────────────────────────────

test('mergeCharacters updates existing character fields by id', () => {
  let s = setCharacters(initialState(), [makeCharacter('c1', 'Hero')])
  s = mergeCharacters(s, [{ ...makeCharacter('c1', 'Hero'), attributes: { hp: 99 } }])
  assert.deepEqual(s.characters[0].attributes, { hp: 99 })
})

test('mergeCharacters adds a truly new character when id is absent from existing list', () => {
  let s = setCharacters(initialState(), [makeCharacter('c1', 'Hero')])
  s = mergeCharacters(s, [makeCharacter('c2', 'Rogue')])
  assert.equal(s.characters.length, 2)
})

test('mergeCharacters matches by name when incoming character has no id', () => {
  let s = setCharacters(initialState(), [makeCharacter('c1', 'Hero')])
  const noId = { ...makeCharacter('', 'Hero'), id: '', attributes: { hp: 42 } }
  s = mergeCharacters(s, [noId])
  assert.equal(s.characters.length, 1)
  assert.equal(s.characters[0].id, 'c1')
  assert.deepEqual(s.characters[0].attributes, { hp: 42 })
})

test('mergeCharacters assigns temp id when incoming character has no id and no name match', () => {
  let s = setCharacters(initialState(), [makeCharacter('c1', 'Hero')])
  const noId = { ...makeCharacter('', 'Stranger'), id: '' }
  s = mergeCharacters(s, [noId])
  assert.equal(s.characters.length, 2)
  assert.equal(s.characters[1].id, 'temp-Stranger')
})

// ─── setWorldState ────────────────────────────────────────────────────────────

test('setWorldState replaces the entire world state', () => {
  const s = setWorldState(initialState(), { gold: 100, region: 'forest' })
  assert.deepEqual(s.worldState, { gold: 100, region: 'forest' })
})

test('setWorldState with empty object clears existing world state', () => {
  let s = setWorldState(initialState(), { gold: 100 })
  s = setWorldState(s, {})
  assert.deepEqual(s.worldState, {})
})

test('setWorldState does not mutate the previous state object', () => {
  const prev = initialState()
  setWorldState(prev, { gold: 100 })
  assert.deepEqual(prev.worldState, {})
})

// ─── setEvents ────────────────────────────────────────────────────────────────

test('setEvents replaces the events list', () => {
  const events = [makeEvent('e1', 'Dragon Slain'), makeEvent('e2', 'Village Saved')]
  const s = setEvents(initialState(), events)
  assert.deepEqual(s.events, events)
})

test('setEvents with empty array clears existing events', () => {
  let s = setEvents(initialState(), [makeEvent('e1', 'Dragon Slain')])
  s = setEvents(s, [])
  assert.equal(s.events.length, 0)
})

// ─── addEvent ─────────────────────────────────────────────────────────────────

test('addEvent appends a new event to the list', () => {
  const s = addEvent(initialState(), makeEvent('e1', 'Dragon Slain'))
  assert.equal(s.events.length, 1)
  assert.equal(s.events[0].id, 'e1')
})

test('addEvent preserves existing events when appending', () => {
  let s = addEvent(initialState(), makeEvent('e1', 'Dragon Slain'))
  s = addEvent(s, makeEvent('e2', 'Village Saved'))
  assert.equal(s.events.length, 2)
  assert.equal(s.events[1].id, 'e2')
})

test('addEvent does not mutate the previous events array', () => {
  const prev = initialState()
  addEvent(prev, makeEvent('e1', 'Dragon Slain'))
  assert.equal(prev.events.length, 0)
})

// ─── updateEvent ──────────────────────────────────────────────────────────────

test('updateEvent replaces the matching event by id', () => {
  const original = makeEvent('e1', 'Dragon Slain')
  let s = setEvents(initialState(), [original])
  s = updateEvent(s, { ...original, status: 'completed' })
  assert.equal(s.events[0].status, 'completed')
})

test('updateEvent leaves other events unchanged', () => {
  const e2 = makeEvent('e2', 'Village Saved')
  let s = setEvents(initialState(), [makeEvent('e1', 'Dragon Slain'), e2])
  s = updateEvent(s, { ...makeEvent('e1', 'Dragon Slain'), status: 'completed' })
  assert.deepEqual(s.events[1], e2)
})

test('updateEvent does not add a new event when id is not found', () => {
  let s = setEvents(initialState(), [makeEvent('e1', 'Dragon Slain')])
  s = updateEvent(s, makeEvent('e99', 'Ghost Event'))
  assert.equal(s.events.length, 1)
})

// ─── reset ────────────────────────────────────────────────────────────────────

test('reset returns state with empty characters, worldState, and events', () => {
  const dirty: GameState = {
    characters: [makeCharacter('c1', 'Hero')],
    worldState: { gold: 50 },
    events: [makeEvent('e1', 'Dragon Slain')],
  }
  const s = initialState()
  assert.equal(s.characters.length, 0)
  assert.deepEqual(s.worldState, {})
  assert.equal(s.events.length, 0)
  // dirty state is unaffected
  assert.equal(dirty.characters.length, 1)
})
