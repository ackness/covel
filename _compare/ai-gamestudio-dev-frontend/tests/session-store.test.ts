import assert from 'node:assert/strict'
import test from 'node:test'
import type { Message } from '../src/types'

// ---------------------------------------------------------------------------
// Pure reducer helpers — mirror the exact logic in sessionStore.ts so we can
// test state transitions without importing Zustand or any side-effect modules.
// ---------------------------------------------------------------------------

interface Block {
  type: string
  data: unknown
  block_id?: string
  output?: { id: string; version: string; type: string; data: unknown }
}

interface PendingBlock {
  type: string
  data: unknown
  blockId: string
  turnId: string
  output?: { id: string; version: string; type: string; data: unknown }
}

interface StoreSlice {
  messages: Message[]
  pendingBlocks: PendingBlock[]
  streamStatus: 'idle' | 'waiting' | 'streaming' | 'done' | 'error'
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

function initialState(): StoreSlice {
  return { messages: [], pendingBlocks: [], streamStatus: 'idle' }
}

// addMessage
function addMessage(state: StoreSlice, message: Message): StoreSlice {
  return { ...state, messages: [...state.messages, message] }
}

// removeLastAssistantMessage (called updateLastAssistantMessage in the task spec,
// but the actual store method is removeLastAssistantMessage)
function removeLastAssistantMessage(state: StoreSlice): StoreSlice {
  const msgs = [...state.messages]
  for (let i = msgs.length - 1; i >= 0; i--) {
    if (msgs[i].role === 'assistant') {
      msgs.splice(i, 1)
      return { ...state, messages: msgs, pendingBlocks: [] }
    }
  }
  return state
}

// addPendingBlock
function addPendingBlock(state: StoreSlice, block: PendingBlock): StoreSlice {
  return { ...state, pendingBlocks: [...state.pendingBlocks, block] }
}

// clearPendingBlocks
function clearPendingBlocks(state: StoreSlice): StoreSlice {
  return { ...state, pendingBlocks: [] }
}

// updateBlockData
function updateBlockData(state: StoreSlice, blockId: string, data: unknown): StoreSlice {
  let found = false
  const nextMessages = state.messages.map((msg) => {
    if (!msg.blocks) return msg
    const updatedBlocks = (msg.blocks as Block[]).map((b) => {
      if (b.block_id === blockId) {
        found = true
        if (b.output && typeof b.output === 'object') {
          return { ...b, data, output: { ...b.output, data } }
        }
        return { ...b, data }
      }
      return b
    })
    return found ? { ...msg, blocks: updatedBlocks } : msg
  })
  if (found) return { ...state, messages: nextMessages }

  const nextPending = state.pendingBlocks.map((b) => {
    if (b.blockId === blockId) {
      found = true
      if (b.output && typeof b.output === 'object') {
        return { ...b, data, output: { ...b.output, data } }
      }
      return { ...b, data }
    }
    return b
  })
  if (found) return { ...state, pendingBlocks: nextPending }

  return state
}

// updateMessageBlocks
function updateMessageBlocks(state: StoreSlice, messageId: string, blocks: Block[]): StoreSlice {
  return {
    ...state,
    messages: state.messages.map((msg) =>
      msg.id === messageId ? { ...msg, blocks } : msg,
    ),
  }
}

// setStreamStatus
function setStreamStatus(
  state: StoreSlice,
  status: StoreSlice['streamStatus'],
): StoreSlice {
  return { ...state, streamStatus: status }
}

// reset
function reset(): StoreSlice {
  return initialState()
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test('addMessage appends a message to an empty list', () => {
  const state = initialState()
  const msg = makeMessage({ id: 'msg-1', role: 'user' })
  const next = addMessage(state, msg)

  assert.equal(next.messages.length, 1)
  assert.equal(next.messages[0].id, 'msg-1')
})

test('addMessage appends to existing messages without mutating original', () => {
  let state = initialState()
  state = addMessage(state, makeMessage({ id: 'msg-1', role: 'user' }))
  const next = addMessage(state, makeMessage({ id: 'msg-2', role: 'assistant' }))

  assert.equal(next.messages.length, 2)
  assert.equal(state.messages.length, 1) // original unchanged
  assert.equal(next.messages[1].id, 'msg-2')
})

test('removeLastAssistantMessage removes the last assistant message', () => {
  let state = initialState()
  state = addMessage(state, makeMessage({ id: 'msg-1', role: 'user' }))
  state = addMessage(state, makeMessage({ id: 'msg-2', role: 'assistant' }))
  const next = removeLastAssistantMessage(state)

  assert.equal(next.messages.length, 1)
  assert.equal(next.messages[0].id, 'msg-1')
})

test('removeLastAssistantMessage clears pendingBlocks', () => {
  let state = initialState()
  state = addMessage(state, makeMessage({ id: 'msg-1', role: 'assistant' }))
  state = addPendingBlock(state, { type: 'choices', data: {}, blockId: 'b-1', turnId: 't-1' })
  const next = removeLastAssistantMessage(state)

  assert.equal(next.pendingBlocks.length, 0)
})

test('removeLastAssistantMessage removes the last assistant when multiple exist', () => {
  let state = initialState()
  state = addMessage(state, makeMessage({ id: 'msg-1', role: 'assistant' }))
  state = addMessage(state, makeMessage({ id: 'msg-2', role: 'user' }))
  state = addMessage(state, makeMessage({ id: 'msg-3', role: 'assistant' }))
  const next = removeLastAssistantMessage(state)

  assert.equal(next.messages.length, 2)
  assert.equal(next.messages[1].id, 'msg-2')
})

test('removeLastAssistantMessage returns same state when no assistant message exists', () => {
  let state = initialState()
  state = addMessage(state, makeMessage({ id: 'msg-1', role: 'user' }))
  const next = removeLastAssistantMessage(state)

  assert.equal(next, state)
})

test('addPendingBlock appends a block to pendingBlocks', () => {
  const state = initialState()
  const block: PendingBlock = { type: 'choices', data: { prompt: 'go?' }, blockId: 'b-1', turnId: 't-1' }
  const next = addPendingBlock(state, block)

  assert.equal(next.pendingBlocks.length, 1)
  assert.equal(next.pendingBlocks[0].blockId, 'b-1')
})

test('addPendingBlock accumulates multiple blocks', () => {
  let state = initialState()
  state = addPendingBlock(state, { type: 'choices', data: {}, blockId: 'b-1', turnId: 't-1' })
  state = addPendingBlock(state, { type: 'guide', data: {}, blockId: 'b-2', turnId: 't-1' })

  assert.equal(state.pendingBlocks.length, 2)
  assert.equal(state.pendingBlocks[1].blockId, 'b-2')
})

test('clearPendingBlocks empties the pendingBlocks array', () => {
  let state = initialState()
  state = addPendingBlock(state, { type: 'choices', data: {}, blockId: 'b-1', turnId: 't-1' })
  const next = clearPendingBlocks(state)

  assert.equal(next.pendingBlocks.length, 0)
})

test('clearPendingBlocks on already-empty state returns empty array', () => {
  const state = initialState()
  const next = clearPendingBlocks(state)

  assert.equal(next.pendingBlocks.length, 0)
})

test('updateBlockData updates data on a flushed block inside a message', () => {
  let state = initialState()
  const msg = makeMessage({
    id: 'msg-1',
    role: 'assistant',
    blocks: [{ type: 'choices', data: { prompt: 'old' }, block_id: 'b-1' }],
  })
  state = addMessage(state, msg)
  const next = updateBlockData(state, 'b-1', { prompt: 'new' })

  const block = (next.messages[0].blocks as Block[])[0]
  assert.deepEqual(block.data, { prompt: 'new' })
})

test('updateBlockData also updates output.data when output is present', () => {
  let state = initialState()
  const msg = makeMessage({
    id: 'msg-1',
    role: 'assistant',
    blocks: [{
      type: 'choices',
      data: { prompt: 'old' },
      block_id: 'b-1',
      output: { id: 'out-1', version: '1.0', type: 'choices', data: { prompt: 'old' } },
    }],
  })
  state = addMessage(state, msg)
  const next = updateBlockData(state, 'b-1', { prompt: 'new' })

  const block = (next.messages[0].blocks as Block[])[0]
  assert.deepEqual(block.data, { prompt: 'new' })
  assert.deepEqual(block.output?.data, { prompt: 'new' })
})

test('updateBlockData updates data on a pending block when not yet flushed', () => {
  let state = initialState()
  state = addPendingBlock(state, { type: 'choices', data: { prompt: 'old' }, blockId: 'b-1', turnId: 't-1' })
  const next = updateBlockData(state, 'b-1', { prompt: 'new' })

  assert.deepEqual(next.pendingBlocks[0].data, { prompt: 'new' })
})

test('updateBlockData returns same state when blockId is not found', () => {
  const state = initialState()
  const next = updateBlockData(state, 'nonexistent', { prompt: 'new' })

  assert.equal(next, state)
})

test('updateMessageBlocks replaces blocks on the matching message', () => {
  let state = initialState()
  state = addMessage(state, makeMessage({ id: 'msg-1', role: 'assistant' }))
  const newBlocks: Block[] = [{ type: 'choices', data: { prompt: 'pick' }, block_id: 'b-1' }]
  const next = updateMessageBlocks(state, 'msg-1', newBlocks)

  assert.equal((next.messages[0].blocks as Block[]).length, 1)
  assert.equal((next.messages[0].blocks as Block[])[0].block_id, 'b-1')
})

test('updateMessageBlocks does not affect other messages', () => {
  let state = initialState()
  state = addMessage(state, makeMessage({ id: 'msg-1', role: 'assistant' }))
  state = addMessage(state, makeMessage({ id: 'msg-2', role: 'assistant' }))
  const next = updateMessageBlocks(state, 'msg-1', [{ type: 'choices', data: {} }])

  assert.equal(next.messages[1].blocks, undefined)
})

test('updateMessageBlocks with unknown messageId leaves messages unchanged', () => {
  let state = initialState()
  state = addMessage(state, makeMessage({ id: 'msg-1', role: 'assistant' }))
  const next = updateMessageBlocks(state, 'nonexistent', [{ type: 'choices', data: {} }])

  assert.equal(next.messages[0].blocks, undefined)
})

test('setStreamStatus transitions from idle to streaming', () => {
  const state = initialState()
  const next = setStreamStatus(state, 'streaming')

  assert.equal(next.streamStatus, 'streaming')
})

test('setStreamStatus transitions through all valid statuses', () => {
  const statuses: StoreSlice['streamStatus'][] = ['idle', 'waiting', 'streaming', 'done', 'error']
  for (const status of statuses) {
    const next = setStreamStatus(initialState(), status)
    assert.equal(next.streamStatus, status)
  }
})

test('reset returns empty messages and pendingBlocks', () => {
  const next = reset()

  assert.equal(next.messages.length, 0)
  assert.equal(next.pendingBlocks.length, 0)
  assert.equal(next.streamStatus, 'idle')
})
