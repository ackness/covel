import { describe, expect, it } from "vitest";

import type { BlockEnvelope, SseEnvelope } from "../../../modules/contracts/src/index.js";
import {
  createInteractiveBlock,
  createSseEnvelope
} from "./helpers/fixtures.js";
import { loadWebModule } from "./helpers/load-web-module.js";

interface WebState {
  timeline: Array<Record<string, unknown>>;
  pendingBlocks: Record<string, Record<string, unknown>>;
  requestStates: Record<string, Record<string, unknown>>;
  errors: Array<Record<string, unknown>>;
}

interface SseReducerModule {
  createInitialWebState(seed?: Record<string, unknown>): WebState;
  reduceSseEnvelope(state: WebState, envelope: SseEnvelope): WebState;
}

describe("apps/web SSE reducer", () => {
  it("concatenates message.delta chunks and seals the timeline item on message.completed", async () => {
    const { createInitialWebState, reduceSseEnvelope } = await loadWebModule<SseReducerModule>(
      "state/sse-reducer.ts"
    );

    let state = createInitialWebState({
      activeSessionId: "ses_01"
    });

    state = reduceSseEnvelope(
      state,
      createSseEnvelope("message.delta", 1, {
        messageId: "msg_01",
        role: "assistant",
        delta: "北风"
      })
    );
    state = reduceSseEnvelope(
      state,
      createSseEnvelope("message.delta", 2, {
        messageId: "msg_01",
        role: "assistant",
        delta: "穿过城门。"
      })
    );
    state = reduceSseEnvelope(
      state,
      createSseEnvelope("message.completed", 3, {
        messageId: "msg_01"
      })
    );

    expect(state.timeline).toContainEqual(
      expect.objectContaining({
        id: "msg_01",
        kind: "message",
        role: "assistant",
        content: "北风穿过城门。",
        status: "completed"
      })
    );
  });

  it("patches pending interactive blocks on block.emitted and block.updated", async () => {
    const { createInitialWebState, reduceSseEnvelope } = await loadWebModule<SseReducerModule>(
      "state/sse-reducer.ts"
    );
    const emittedBlock = createInteractiveBlock();
    const updatedBlock = createInteractiveBlock({
      data: {
        title: "你要如何进入塔楼？",
        options: [
          {
            id: "opt_a",
            label: "走正门"
          },
          {
            id: "opt_b",
            label: "翻窗潜入"
          }
        ]
      }
    });

    let state = createInitialWebState();
    state = reduceSseEnvelope(
      state,
      createSseEnvelope("block.emitted", 1, {
        block: emittedBlock
      })
    );
    state = reduceSseEnvelope(
      state,
      createSseEnvelope("block.updated", 2, {
        blockId: emittedBlock.id,
        block: updatedBlock
      })
    );

    expect(state.pendingBlocks[emittedBlock.id]).toEqual(
      expect.objectContaining({
        id: emittedBlock.id,
        type: emittedBlock.type,
        data: updatedBlock.data
      })
    );
  });

  it("distinguishes retryable error events from terminal flow.failed events", async () => {
    const { createInitialWebState, reduceSseEnvelope } = await loadWebModule<SseReducerModule>(
      "state/sse-reducer.ts"
    );

    let state = createInitialWebState();
    state = reduceSseEnvelope(
      state,
      createSseEnvelope("error", 1, {
        message: "Provider timeout, retrying."
      })
    );
    state = reduceSseEnvelope(
      state,
      createSseEnvelope("flow.failed", 2, {
        code: "MODEL_UNAVAILABLE",
        message: "Provider exhausted retries."
      })
    );

    expect(state.errors).toEqual([
      expect.objectContaining({
        terminal: false,
        message: "Provider timeout, retrying."
      }),
      expect.objectContaining({
        terminal: true,
        code: "MODEL_UNAVAILABLE",
        message: "Provider exhausted retries."
      })
    ]);
    expect(state.requestStates.req_01).toEqual(
      expect.objectContaining({
        status: "failed"
      })
    );
  });
});
