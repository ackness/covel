import type { Message } from '../types'
import type { OutputEnvelope } from '../services/outputContract'

export interface TurnPendingBlock {
  type: string
  data: unknown
  output?: OutputEnvelope
  turnId?: string
  blockId: string
}

export function attachPendingBlocksForTurn(
  messages: Message[],
  pendingBlocks: TurnPendingBlock[],
  turnId: string,
): { messages: Message[]; pendingBlocks: TurnPendingBlock[] } {
  if (!turnId || pendingBlocks.length === 0) {
    return { messages, pendingBlocks }
  }

  const targetBlocks = pendingBlocks.filter((b) => b.turnId === turnId)
  if (targetBlocks.length === 0) {
    return { messages, pendingBlocks }
  }

  const remainingBlocks = pendingBlocks.filter((b) => b.turnId !== turnId)
  const nextMessages = [...messages]

  // Prefer assistant message with matching turn_id.
  let targetIdx = -1
  for (let i = nextMessages.length - 1; i >= 0; i--) {
    if (nextMessages[i].role === 'assistant' && nextMessages[i].turn_id === turnId) {
      targetIdx = i
      break
    }
  }

  if (targetIdx < 0) {
    return { messages, pendingBlocks }
  }

  nextMessages[targetIdx] = {
    ...nextMessages[targetIdx],
    blocks: [
      ...(nextMessages[targetIdx].blocks || []),
      ...targetBlocks.map((b) => ({
        type: b.type,
        data: b.data,
        block_id: b.blockId,
        output: b.output,
      })),
    ],
  }

  return { messages: nextMessages, pendingBlocks: remainingBlocks }
}
