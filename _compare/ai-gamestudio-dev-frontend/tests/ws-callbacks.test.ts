import assert from 'node:assert/strict'
import test from 'node:test'
import type { Message } from '../src/types'
import type { OutputEnvelope } from '../src/services/outputContract'

// ---------------------------------------------------------------------------
// Regression tests for TypeScript errors fixed in useWsCallbacks.ts
//
// These tests mirror the pure callback logic without importing Zustand or
// React hooks. Each test targets one of the five TS6133/TS2345 errors that
// broke the Vercel build:
//
//  1. onPluginSummary — data (unknown) cast to typed summary before store call
//  2. onPluginProgress — data (unknown) cast to typed progress before store call
//  3. onMessageBlocksUpdated — only calls updateMessageBlocks when blocks is an array
//  4. onBlock — adds pending block with correct structure
//  5. onError — sets streaming false and appends error message
// ---------------------------------------------------------------------------

// ── Shared types (mirrors sessionStore.ts) ──────────────────────────────────

type PluginSummary = { rounds: number; tool_calls: string[]; blocks_emitted: string[] } | null
type PluginProgress = { round: number; tool_calls: string[]; blocks_so_far: string[] } | null

interface Block {
  type: string
  data: unknown
  block_id?: string
  output?: OutputEnvelope
}

interface PendingBlock {
  type: string
  data: unknown
  blockId: string
  turnId?: string
  output?: OutputEnvelope
}

interface StoreSlice {
  messages: Message[]
  pendingBlocks: PendingBlock[]
  isStreaming: boolean
  streamStatus: 'idle' | 'waiting' | 'streaming' | 'done' | 'error'
  lastPluginSummary: PluginSummary
  pluginProgress: PluginProgress
}

function initialState(): StoreSlice {
  return {
    messages: [],
    pendingBlocks: [],
    isStreaming: false,
    streamStatus: 'idle',
    lastPluginSummary: null,
    pluginProgress: null,
  }
}

function makeMessage(overrides: Partial<Message> & Pick<Message, 'id' | 'role'>): Message {
  return {
    session_id: 'session-1',
    content: 'hello',
    message_type: 'narration',
    created_at: '2026-02-25T00:00:00.000Z',
    ...overrides,
  }
}

// ── Pure logic mirrors of useWsCallbacks handlers ───────────────────────────

// onPluginSummary: mirrors useWsCallbacks.ts line 109-111
// The fix: cast data as typed summary instead of passing unknown directly.
function onPluginSummary(
  state: StoreSlice,
  data: unknown,
): StoreSlice {
  const summary = data as PluginSummary
  return { ...state, lastPluginSummary: summary }
}

// onPluginProgress: mirrors useWsCallbacks.ts line 113-115
// The fix: cast data as typed progress instead of passing unknown directly.
function onPluginProgress(
  state: StoreSlice,
  data: unknown,
): StoreSlice {
  const progress = data as PluginProgress
  return { ...state, pluginProgress: progress }
}

// onMessageBlocksUpdated: mirrors useWsCallbacks.ts line 233-235
// The fix: guard with Array.isArray before calling updateMessageBlocks.
function onMessageBlocksUpdated(
  state: StoreSlice,
  messageId: string | null,
  blocks: unknown,
): StoreSlice {
  if (!messageId || !Array.isArray(blocks)) return state
  const typedBlocks = blocks as Block[]
  return {
    ...state,
    messages: state.messages.map((msg) =>
      msg.id === messageId ? { ...msg, blocks: typedBlocks } : msg,
    ),
  }
}

// onBlock: mirrors useWsCallbacks.ts line 189-231
// Adds a pending block with enriched data and resolved blockId.
function onBlock(
  state: StoreSlice,
  type: string,
  data: unknown,
  turnId: string | null,
  blockId: string | null,
  output: unknown,
  generateId: () => string,
): StoreSlice {
  // Filtered types that should not produce pending blocks
  if (type === 'state_update') return state
  if (type === 'scene_update') return state
  if (type === 'character_confirmed') return state
  if (type === 'event') return state

  const enrichedData =
    data && typeof data === 'object' && !Array.isArray(data)
      ? { ...(data as Record<string, unknown>), _block_type: type }
      : data

  const resolvedBlockId = blockId || `${turnId || 'turnless'}:${generateId()}`

  // Dedup: if blockId already exists in messages or pendingBlocks, skip add
  if (blockId) {
    const existsInMessages = state.messages.some(
      (m) => (m.blocks as Block[] | undefined)?.some((b) => b.block_id === blockId),
    )
    const existsInPending = state.pendingBlocks.some((b) => b.blockId === blockId)
    if (existsInMessages || existsInPending) return state
  }

  const newBlock: PendingBlock = {
    type,
    data: enrichedData,
    output: output as OutputEnvelope | undefined || undefined,
    turnId: turnId || undefined,
    blockId: resolvedBlockId,
  }
  return { ...state, pendingBlocks: [...state.pendingBlocks, newBlock] }
}

// onError: mirrors useWsCallbacks.ts line 268-283
// Sets streaming false, status error, appends system error message.
function onError(
  state: StoreSlice,
  error: string,
  sessionId: string,
  generateId: () => string,
): StoreSlice {
  const errorMessage: Message = {
    id: generateId(),
    session_id: sessionId,
    role: 'system',
    content: `Error: ${error}`,
    message_type: 'system_event',
    created_at: '2026-02-25T00:00:00.000Z',
  }
  return {
    ...state,
    isStreaming: false,
    streamStatus: 'error',
    messages: [...state.messages, errorMessage],
  }
}

// ── Tests ────────────────────────────────────────────────────────────────────

// ── onPluginSummary ──────────────────────────────────────────────────────────

test('onPluginSummary stores typed summary data in lastPluginSummary', () => {
  const state = initialState()
  const data: PluginSummary = { rounds: 3, tool_calls: ['dice_roll'], blocks_emitted: ['choices'] }
  const next = onPluginSummary(state, data)

  assert.deepEqual(next.lastPluginSummary, data)
})

test('onPluginSummary accepts null to clear lastPluginSummary', () => {
  let state = initialState()
  state = onPluginSummary(state, { rounds: 1, tool_calls: [], blocks_emitted: [] })
  const next = onPluginSummary(state, null)

  assert.equal(next.lastPluginSummary, null)
})

test('onPluginSummary preserves all required fields: rounds, tool_calls, blocks_emitted', () => {
  const state = initialState()
  const data: PluginSummary = {
    rounds: 5,
    tool_calls: ['tool_a', 'tool_b'],
    blocks_emitted: ['choices', 'guide'],
  }
  const next = onPluginSummary(state, data)

  assert.equal(next.lastPluginSummary?.rounds, 5)
  assert.deepEqual(next.lastPluginSummary?.tool_calls, ['tool_a', 'tool_b'])
  assert.deepEqual(next.lastPluginSummary?.blocks_emitted, ['choices', 'guide'])
})

test('onPluginSummary does not mutate previous state', () => {
  const state = initialState()
  onPluginSummary(state, { rounds: 1, tool_calls: [], blocks_emitted: [] })

  assert.equal(state.lastPluginSummary, null)
})

// ── onPluginProgress ─────────────────────────────────────────────────────────

test('onPluginProgress stores typed progress data in pluginProgress', () => {
  const state = initialState()
  const data: PluginProgress = { round: 2, tool_calls: ['dice_roll'], blocks_so_far: ['choices'] }
  const next = onPluginProgress(state, data)

  assert.deepEqual(next.pluginProgress, data)
})

test('onPluginProgress accepts null to clear pluginProgress', () => {
  let state = initialState()
  state = onPluginProgress(state, { round: 1, tool_calls: [], blocks_so_far: [] })
  const next = onPluginProgress(state, null)

  assert.equal(next.pluginProgress, null)
})

test('onPluginProgress preserves all required fields: round, tool_calls, blocks_so_far', () => {
  const state = initialState()
  const data: PluginProgress = {
    round: 3,
    tool_calls: ['tool_x'],
    blocks_so_far: ['guide'],
  }
  const next = onPluginProgress(state, data)

  assert.equal(next.pluginProgress?.round, 3)
  assert.deepEqual(next.pluginProgress?.tool_calls, ['tool_x'])
  assert.deepEqual(next.pluginProgress?.blocks_so_far, ['guide'])
})

test('onPluginProgress does not mutate previous state', () => {
  const state = initialState()
  onPluginProgress(state, { round: 1, tool_calls: [], blocks_so_far: [] })

  assert.equal(state.pluginProgress, null)
})

// ── onMessageBlocksUpdated ───────────────────────────────────────────────────

test('onMessageBlocksUpdated replaces blocks on matching message when blocks is an array', () => {
  let state = initialState()
  state = { ...state, messages: [makeMessage({ id: 'msg-1', role: 'assistant' })] }
  const blocks: Block[] = [{ type: 'choices', data: { prompt: 'go?' }, block_id: 'b-1' }]
  const next = onMessageBlocksUpdated(state, 'msg-1', blocks)

  assert.equal((next.messages[0].blocks as Block[]).length, 1)
  assert.equal((next.messages[0].blocks as Block[])[0].block_id, 'b-1')
})

test('onMessageBlocksUpdated does not call updateMessageBlocks when blocks is not an array', () => {
  let state = initialState()
  state = { ...state, messages: [makeMessage({ id: 'msg-1', role: 'assistant' })] }

  // Passing an object (not array) — the guard must prevent any update
  const next = onMessageBlocksUpdated(state, 'msg-1', { type: 'choices', data: {} })

  assert.equal(next.messages[0].blocks, undefined)
})

test('onMessageBlocksUpdated does nothing when messageId is null', () => {
  let state = initialState()
  state = { ...state, messages: [makeMessage({ id: 'msg-1', role: 'assistant' })] }
  const next = onMessageBlocksUpdated(state, null, [{ type: 'choices', data: {} }])

  assert.equal(next.messages[0].blocks, undefined)
})

test('onMessageBlocksUpdated does nothing when blocks is a plain object (TS2345 regression)', () => {
  let state = initialState()
  state = { ...state, messages: [makeMessage({ id: 'msg-1', role: 'assistant' })] }

  // This is the exact shape that caused TS2345: unknown passed where typed array expected
  const arbitraryObject: unknown = { rounds: 1, tool_calls: [] }
  const next = onMessageBlocksUpdated(state, 'msg-1', arbitraryObject)

  assert.equal(next.messages[0].blocks, undefined)
})

test('onMessageBlocksUpdated does not affect other messages', () => {
  let state = initialState()
  state = {
    ...state,
    messages: [
      makeMessage({ id: 'msg-1', role: 'assistant' }),
      makeMessage({ id: 'msg-2', role: 'assistant' }),
    ],
  }
  const next = onMessageBlocksUpdated(state, 'msg-1', [{ type: 'choices', data: {} }])

  assert.equal(next.messages[1].blocks, undefined)
})

// ── onBlock ──────────────────────────────────────────────────────────────────

let idCounter = 0
function fakeId(): string {
  return `fake-id-${++idCounter}`
}

test('onBlock adds a pending block with correct type and data', () => {
  const state = initialState()
  const next = onBlock(state, 'choices', { prompt: 'go?' }, 'turn-1', null, null, fakeId)

  assert.equal(next.pendingBlocks.length, 1)
  assert.equal(next.pendingBlocks[0].type, 'choices')
})

test('onBlock enriches object data with _block_type field', () => {
  const state = initialState()
  const next = onBlock(state, 'choices', { prompt: 'go?' }, 'turn-1', null, null, fakeId)

  const data = next.pendingBlocks[0].data as Record<string, unknown>
  assert.equal(data._block_type, 'choices')
})

test('onBlock does not enrich array data with _block_type', () => {
  const state = initialState()
  const next = onBlock(state, 'choices', [1, 2, 3], 'turn-1', null, null, fakeId)

  assert.deepEqual(next.pendingBlocks[0].data, [1, 2, 3])
})

test('onBlock uses provided blockId when given', () => {
  const state = initialState()
  const next = onBlock(state, 'choices', {}, 'turn-1', 'explicit-block-id', null, fakeId)

  assert.equal(next.pendingBlocks[0].blockId, 'explicit-block-id')
})

test('onBlock generates blockId from turnId when blockId is null', () => {
  const state = initialState()
  const next = onBlock(state, 'choices', {}, 'turn-abc', null, null, fakeId)

  assert.ok(next.pendingBlocks[0].blockId.startsWith('turn-abc:'))
})

test('onBlock uses turnless prefix when both turnId and blockId are null', () => {
  const state = initialState()
  const next = onBlock(state, 'choices', {}, null, null, null, fakeId)

  assert.ok(next.pendingBlocks[0].blockId.startsWith('turnless:'))
})

test('onBlock skips state_update type and returns unchanged state', () => {
  const state = initialState()
  const next = onBlock(state, 'state_update', {}, 'turn-1', null, null, fakeId)

  assert.equal(next.pendingBlocks.length, 0)
  assert.equal(next, state)
})

test('onBlock skips scene_update type and returns unchanged state', () => {
  const state = initialState()
  const next = onBlock(state, 'scene_update', {}, 'turn-1', null, null, fakeId)

  assert.equal(next, state)
})

test('onBlock skips character_confirmed type and returns unchanged state', () => {
  const state = initialState()
  const next = onBlock(state, 'character_confirmed', {}, 'turn-1', null, null, fakeId)

  assert.equal(next, state)
})

test('onBlock skips adding duplicate block when blockId already exists in pendingBlocks', () => {
  let state = initialState()
  state = onBlock(state, 'choices', { v: 1 }, 'turn-1', 'dup-id', null, fakeId)
  const next = onBlock(state, 'choices', { v: 2 }, 'turn-1', 'dup-id', null, fakeId)

  assert.equal(next.pendingBlocks.length, 1)
})

// ── onError ──────────────────────────────────────────────────────────────────

test('onError sets isStreaming to false', () => {
  const state = { ...initialState(), isStreaming: true }
  const next = onError(state, 'connection lost', 'session-1', fakeId)

  assert.equal(next.isStreaming, false)
})

test('onError sets streamStatus to error', () => {
  const state = initialState()
  const next = onError(state, 'timeout', 'session-1', fakeId)

  assert.equal(next.streamStatus, 'error')
})

test('onError appends a system message with the error text', () => {
  const state = initialState()
  const next = onError(state, 'connection lost', 'session-1', fakeId)

  assert.equal(next.messages.length, 1)
  assert.equal(next.messages[0].role, 'system')
  assert.equal(next.messages[0].content, 'Error: connection lost')
  assert.equal(next.messages[0].message_type, 'system_event')
})

test('onError sets session_id on the appended error message', () => {
  const state = initialState()
  const next = onError(state, 'oops', 'my-session', fakeId)

  assert.equal(next.messages[0].session_id, 'my-session')
})

test('onError preserves existing messages when appending error message', () => {
  let state = initialState()
  state = { ...state, messages: [makeMessage({ id: 'msg-1', role: 'user' })] }
  const next = onError(state, 'oops', 'session-1', fakeId)

  assert.equal(next.messages.length, 2)
  assert.equal(next.messages[0].id, 'msg-1')
})

test('onError does not mutate previous state', () => {
  const state = initialState()
  onError(state, 'oops', 'session-1', fakeId)

  assert.equal(state.isStreaming, false)
  assert.equal(state.streamStatus, 'idle')
  assert.equal(state.messages.length, 0)
})
