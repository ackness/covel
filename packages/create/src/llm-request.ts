import {
  awaitLlmRequest,
  createLlmRequestBudget,
  iterateLlmRequest,
  WORLD_AUTHORING_IDLE_TIMEOUT_MS,
} from "@covel/shared";
import type { LLMAdapter, LLMMessage, LLMResponse } from "@covel/shared";

/**
 * The gateway ends a request after 120 seconds unless the caller gives it a
 * budget. Authoring answers are long and some models write slowly, so the
 * limit that applies here is the idle timeout. This ceiling only ends a model
 * that never stops writing.
 */
const REQUEST_CEILING_MS = 30 * 60_000;

/** The model sent nothing for the whole idle timeout. */
export class LlmIdleTimeoutError extends Error {
  constructor(readonly idleTimeoutMs: number) {
    super(`The model sent no output for ${idleTimeoutMs / 1000} seconds`);
    this.name = "LlmIdleTimeoutError";
  }
}

interface LlmRequestOptions {
  readonly llm: LLMAdapter;
  readonly messages: readonly LLMMessage[];
  readonly model?: string;
  readonly signal: AbortSignal;
  /**
   * Longest wait for the next output of the model. Each piece of text or
   * reasoning starts the wait again. An adapter that cannot stream sends its
   * whole answer at once, so there the wait covers the whole request.
   */
  readonly idleTimeoutMs?: number;
  /** Receives the length of the answer each time the model writes more of it. */
  readonly onText?: (length: number) => void;
}

export async function requestLlmResponse(
  options: LlmRequestOptions,
): Promise<LLMResponse> {
  options.signal.throwIfAborted();
  const idleTimeoutMs =
    options.idleTimeoutMs ?? WORLD_AUTHORING_IDLE_TIMEOUT_MS.default;
  const idle = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const wait = () => {
    clearTimeout(timer);
    timer = setTimeout(
      () => idle.abort(new LlmIdleTimeoutError(idleTimeoutMs)),
      idleTimeoutMs,
    );
  };
  const signal = AbortSignal.any([options.signal, idle.signal]);
  const request = {
    model: options.model,
    messages: options.messages,
    signal,
    requestBudget: createLlmRequestBudget({ timeoutMs: REQUEST_CEILING_MS }),
  };

  wait();
  try {
    if (!options.llm.stream) {
      const response = await awaitLlmRequest(
        options.llm.generate(request),
        signal,
      );
      signal.throwIfAborted();
      return response;
    }

    let content = "";
    let finishReason: LLMResponse["finishReason"] = "stop";
    let reasoningContent = "";

    for await (const event of iterateLlmRequest(
      options.llm.stream(request),
      signal,
    )) {
      signal.throwIfAborted();
      wait();
      if (event.type === "text-delta") {
        content += event.textDelta;
        options.onText?.(content.length);
      } else if (event.type === "done") {
        finishReason =
          event.finishReason === "tool_calls" ||
          event.finishReason === "length" ||
          event.finishReason === "error"
            ? event.finishReason
            : "stop";
        reasoningContent = event.reasoningContent ?? "";
      }
    }

    signal.throwIfAborted();

    return {
      content: content || null,
      toolCalls: [],
      finishReason,
      usage: { inputTokens: 0, outputTokens: 0 },
      ...(reasoningContent ? { reasoningContent } : {}),
    };
  } catch (error) {
    // An adapter may report the aborted request with an error of its own.
    if (idle.signal.aborted && !options.signal.aborted)
      throw idle.signal.reason;
    throw error;
  } finally {
    clearTimeout(timer);
  }
}
