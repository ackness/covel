import { afterEach, describe, expect, it, vi } from "vitest";
import {
  acquireLLMSlot,
  setLLMSlotCapForTests,
} from "../src/retry/llm-slots.js";
import {
  buildRetryPolicy,
  callLLMWithRetry,
  streamLLMWithRetry,
} from "../src/retry/llm-retry.js";
import type { LLMAdapter } from "../src/llm/llm-adapter.js";

afterEach(() => setLLMSlotCapForTests(undefined));

describe("cancel queued model attempts", () => {
  it.each([false, true])(
    "exits before the provider call (streaming=%s)",
    async (streaming) => {
      setLLMSlotCapForTests(1);
      const holder = await acquireLLMSlot();
      const controller = new AbortController();
      const generate = vi.fn();
      const stream = vi.fn();
      const llm: LLMAdapter = { generate, stream };
      const params = {
        llm,
        messages: [],
        abortSignal: controller.signal,
        policy: buildRetryPolicy({ runtimeTimeoutMs: 1000 }),
        deadline: Date.now() + 1000,
      };
      try {
        const call = streaming
          ? streamLLMWithRetry(params)
          : callLLMWithRetry(params);
        const rejected = expect(call).rejects.toMatchObject({
          code: "TURN_ABORTED",
        });
        controller.abort();
        await rejected;
        expect(generate).not.toHaveBeenCalled();
        expect(stream).not.toHaveBeenCalled();
      } finally {
        holder.release();
      }
      (await acquireLLMSlot()).release();
    },
  );
});
