import {
  combineAbortSignals,
  getTurnExecutionSignal,
  throwIfTurnExecutionAborted,
  RuntimeTimeoutError,
  type TurnControl,
} from "../turn-executor/turn-control.js";

/** Signal tool and hook work without charging model-slot queue time. */
export function createAgentLoopBudget(
  timeoutMs: number,
  runtimeId: string,
  parent: TurnControl | undefined,
) {
  const controller = new AbortController();
  const control = {
    ...parent,
    executionSignal: combineAbortSignals(
      parent?.executionSignal,
      controller.signal,
    ),
  };
  let deadline = Date.now() + timeoutMs;
  let timer: ReturnType<typeof setTimeout> | undefined;
  function expire() {
    controller.abort(
      new RuntimeTimeoutError(
        `agent runtime "${runtimeId}" timed out after ${timeoutMs}ms`,
      ),
    );
  }
  function clear() {
    clearTimeout(timer);
    timer = undefined;
  }
  function arm() {
    clear();
    const remaining = deadline - Date.now();
    if (remaining <= 0) expire();
    else timer = setTimeout(expire, remaining);
  }
  function assertLive() {
    if (Date.now() >= deadline) expire();
    throwIfTurnExecutionAborted(control, runtimeId);
  }
  arm();
  return {
    signal: getTurnExecutionSignal(control),
    get deadline() {
      return deadline;
    },
    assertLive,
    // The model retry layer owns its per-attempt timers and queue exclusion.
    // Re-arm our timer with its reported queue compensation after it returns.
    pauseForModel() {
      assertLive();
      clear();
    },
    extend(waitedMs: number) {
      deadline += waitedMs;
    },
    resumeAfterModel: arm,
    close: clear,
  };
}
