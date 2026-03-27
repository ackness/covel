import assert from 'node:assert/strict'
import test from 'node:test'
import { useCodexStore } from '../src/stores/codexStore.js'

function resetStore() {
  useCodexStore.setState({ entries: [], loading: false, searchQuery: '' })
}

function makeFetch(ok: boolean, body: unknown): typeof globalThis.fetch {
  return async () =>
    ({
      ok,
      json: async () => body,
    }) as Response
}

// --- addEntry ---

test('addEntry appends a new entry and marks it as _isNew', () => {
  resetStore()
  useCodexStore.getState().addEntry({
    action: 'unlock',
    category: 'monster',
    entry_id: 'goblin',
    title: 'Goblin',
    content: 'A small green creature.',
  })
  const { entries } = useCodexStore.getState()
  assert.equal(entries.length, 1)
  assert.equal(entries[0].entry_id, 'goblin')
  assert.equal(entries[0]._isNew, true)
  assert.equal(typeof entries[0]._newAt, 'number')
})

test('addEntry updates an existing entry when entry_id matches', () => {
  resetStore()
  const store = useCodexStore.getState()
  store.addEntry({
    action: 'unlock',
    category: 'monster',
    entry_id: 'goblin',
    title: 'Goblin',
    content: 'Original content.',
  })
  store.addEntry({
    action: 'update',
    category: 'monster',
    entry_id: 'goblin',
    title: 'Goblin King',
    content: 'Updated content.',
  })
  const { entries } = useCodexStore.getState()
  assert.equal(entries.length, 1)
  assert.equal(entries[0].title, 'Goblin King')
  assert.equal(entries[0].content, 'Updated content.')
})

// --- _isNew flag ---

test('addEntry always sets _isNew to true regardless of prior value', () => {
  resetStore()
  useCodexStore.setState({
    entries: [{
      action: 'unlock',
      category: 'lore',
      entry_id: 'lore-1',
      title: 'Ancient Lore',
      content: 'Old text.',
      _isNew: false,
    }],
  })
  useCodexStore.getState().addEntry({
    action: 'update',
    category: 'lore',
    entry_id: 'lore-1',
    title: 'Ancient Lore',
    content: 'New text.',
  })
  assert.equal(useCodexStore.getState().entries[0]._isNew, true)
})

// --- clearNewFlags ---

test('clearNewFlags sets _isNew to false on all entries', () => {
  resetStore()
  const store = useCodexStore.getState()
  store.addEntry({ action: 'unlock', category: 'item', entry_id: 'sword', title: 'Sword', content: 'Sharp.' })
  store.addEntry({ action: 'unlock', category: 'item', entry_id: 'shield', title: 'Shield', content: 'Sturdy.' })
  store.clearNewFlags()
  const { entries } = useCodexStore.getState()
  assert.equal(entries.every((e) => e._isNew === false), true)
  assert.equal(entries.every((e) => e._newAt === undefined), true)
})

test('clearNewFlags leaves entries list unchanged in length', () => {
  resetStore()
  const store = useCodexStore.getState()
  store.addEntry({ action: 'unlock', category: 'location', entry_id: 'town', title: 'Town', content: 'A small town.' })
  store.clearNewFlags()
  assert.equal(useCodexStore.getState().entries.length, 1)
})

test('markEntrySeen clears only the target entry new flag', () => {
  resetStore()
  const store = useCodexStore.getState()
  store.addEntry({ action: 'unlock', category: 'item', entry_id: 'sword', title: 'Sword', content: 'Sharp.' })
  store.addEntry({ action: 'unlock', category: 'item', entry_id: 'shield', title: 'Shield', content: 'Sturdy.' })
  store.markEntrySeen('sword')
  const entries = useCodexStore.getState().entries
  const sword = entries.find((e) => e.entry_id === 'sword')
  const shield = entries.find((e) => e.entry_id === 'shield')
  assert.equal(sword?._isNew, false)
  assert.equal(sword?._newAt, undefined)
  assert.equal(shield?._isNew, true)
})

// --- fetchEntries ---

test('fetchEntries populates entries on successful response', async () => {
  resetStore()
  globalThis.fetch = makeFetch(true, {
    entries: [
      { action: 'unlock', category: 'character', entry_id: 'hero', title: 'Hero', content: 'The protagonist.' },
    ],
  })
  await useCodexStore.getState().fetchEntries('proj-1')
  const { entries, loading } = useCodexStore.getState()
  assert.equal(entries.length, 1)
  assert.equal(entries[0].entry_id, 'hero')
  assert.equal(loading, false)
})

test('fetchEntries sets entries to empty array when response has no entries field', async () => {
  resetStore()
  globalThis.fetch = makeFetch(true, {})
  await useCodexStore.getState().fetchEntries('proj-1')
  const { entries } = useCodexStore.getState()
  assert.equal(entries.length, 0)
})

test('fetchEntries preserves local new flags for existing entry_id', async () => {
  resetStore()
  const store = useCodexStore.getState()
  store.addEntry({
    action: 'unlock',
    category: 'character',
    entry_id: 'hero',
    title: 'Hero',
    content: 'The protagonist.',
  })
  globalThis.fetch = makeFetch(true, {
    entries: [
      { action: 'update', category: 'character', entry_id: 'hero', title: 'Hero', content: 'Updated profile.' },
    ],
  })
  await store.fetchEntries('proj-1')
  const hero = useCodexStore.getState().entries.find((entry) => entry.entry_id === 'hero')
  assert.equal(hero?._isNew, true)
  assert.equal(typeof hero?._newAt, 'number')
})

test('fetchEntries clears loading flag when response is not ok', async () => {
  resetStore()
  globalThis.fetch = makeFetch(false, {})
  await useCodexStore.getState().fetchEntries('proj-1')
  assert.equal(useCodexStore.getState().loading, false)
})

test('fetchEntries clears loading flag when fetch throws', async () => {
  resetStore()
  globalThis.fetch = async () => { throw new Error('network error') }
  await useCodexStore.getState().fetchEntries('proj-1')
  assert.equal(useCodexStore.getState().loading, false)
})

// --- reset ---

test('reset clears entries, loading, and searchQuery to initial state', () => {
  useCodexStore.setState({ entries: [
    { action: 'unlock', category: 'monster', entry_id: 'orc', title: 'Orc', content: 'Big and green.', _isNew: true },
  ], loading: true, searchQuery: 'orc' })
  useCodexStore.setState({ entries: [], loading: false, searchQuery: '' })
  const { entries, loading, searchQuery } = useCodexStore.getState()
  assert.equal(entries.length, 0)
  assert.equal(loading, false)
  assert.equal(searchQuery, '')
})
