import assert from 'node:assert/strict'
import test from 'node:test'
import type { Message } from '../src/types'
import { attachPendingBlocksForTurn } from '../src/stores/sessionTurnUtils.js'

function assistantMessage(id: string, turnId: string): Message {
  return {
    id,
    session_id: 'session-1',
    role: 'assistant',
    content: id,
    turn_id: turnId,
    message_type: 'narration',
    created_at: '2026-02-17T00:00:00.000Z',
  }
}

test('pending blocks are attached to assistant message with matching turn_id', () => {
  const messages = [
    assistantMessage('msg-a', 'turn-a'),
    assistantMessage('msg-b', 'turn-b'),
  ]
  const pendingBlocks = [
    {
      type: 'choices',
      data: { prompt: 'go?' },
      output: { id: 'out-a', version: '1.0', type: 'choices', data: { prompt: 'go?' } },
      turnId: 'turn-a',
      blockId: 'block-a',
    },
  ]

  const merged = attachPendingBlocksForTurn(messages, pendingBlocks, 'turn-a')

  assert.equal(merged.pendingBlocks.length, 0)
  assert.equal(merged.messages[0].blocks?.[0].block_id, 'block-a')
  assert.equal(merged.messages[0].blocks?.[0].output?.id, 'out-a')
  assert.equal(merged.messages[0].blocks?.[0].output?.type, 'choices')
  assert.equal(merged.messages[1].blocks, undefined)
})

test('pending blocks are not attached to other assistant messages when turn_id does not match', () => {
  const messages = [assistantMessage('msg-b', 'turn-b')]
  const pendingBlocks = [
    {
      type: 'choices',
      data: { prompt: 'go?' },
      turnId: 'turn-a',
      blockId: 'block-a',
    },
  ]

  const merged = attachPendingBlocksForTurn(messages, pendingBlocks, 'turn-a')

  assert.equal(merged.pendingBlocks.length, 1)
  assert.equal(merged.messages[0].blocks, undefined)
})
