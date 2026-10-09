import {
  awaitLlmRequest,
  createLlmRequestBudget,
  DEFAULT_LLM_REQUEST_CEILING_MS,
  iterateLlmRequest,
  unifyFinishReason,
  WORLD_AUTHORING_IDLE_TIMEOUT_MS,
} from "@covel/shared";
import type { LLMAdapter, LLMMessage, LLMResponse } from "@covel/shared";

/** The model sent nothing for the whole idle timeout. */
export class LlmIdleTimeoutError extends Error {
  constructor(readonly idleTimeoutMs: number) {
    super(`The model sent no output for ${idleTimeoutMs / 1000} seconds`);
    this.name = "LlmIdleTimeoutError";
  }
}

/** A partial answer cannot be validated or repaired as a complete document. */
export class LlmIncompleteOutputError extends Error {
  constructor(reason: string) {
    super(
      `The model did not complete its answer (${reason}); increase its output limit or request a smaller part`,
    );
    this.name = "LlmIncompleteOutputError";
  }
}

function requireComplete(reason: string | undefined): void {
  const unified = unifyFinishReason(reason);
  if (unified === "length" || unified === "error")
    throw new LlmIncompleteOutputError(reason ?? unified);
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
    // The default budget waits 120 seconds for the first output, and the
    // player may set a longer wait. The idle timer below is the limit that
    // applies here; this fixed budget only ends a model that never stops
    // writing.
    requestBudget: createLlmRequestBudget({
      timeoutMs: DEFAULT_LLM_REQUEST_CEILING_MS,
    }),
  };

  wait();
  try {
    if (!options.llm.stream) {
      const response = await awaitLlmRequest(
        options.llm.generate(request),
        signal,
      );
      signal.throwIfAborted();
      requireComplete(response.finishReason);
      return response;
    }

    let content = "";
    let finishReason: LLMResponse["finishReason"] = "stop";
    let reasoningContent = "";
    let completed = false;

    for await (const event of iterateLlmRequest(
      options.llm.stream(request),
      signal,
    )) {
      signal.throwIfAborted();
      // Only output restarts the wait: an empty event is not an answer.
      if (event.type === "text-delta") {
        if (event.textDelta.length === 0) continue;
        wait();
        content += event.textDelta;
        options.onText?.(content.length);
      } else if (event.type === "reasoning-delta") {
        if (event.reasoningDelta.length > 0) wait();
      } else if (event.type === "done") {
        requireComplete(event.finishReason);
        completed = true;
        finishReason =
          unifyFinishReason(event.finishReason) === "tool_calls"
            ? "tool_calls"
            : "stop";
        reasoningContent = event.reasoningContent ?? "";
      }
    }

    signal.throwIfAborted();
    if (!completed) throw new LlmIncompleteOutputError("missing done event");

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
