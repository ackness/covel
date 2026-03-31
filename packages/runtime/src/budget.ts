import type { RuntimeBudget } from "@covel/shared";

/**
 * Budget enforcer for runtime execution.
 *
 * Enforces:
 * - maxSteps: hard limit on tool-calling iterations
 * - timeoutMs: hard timeout via AbortController
 * - maxTokens: best-effort tracking (accumulated, not enforced)
 */
export interface BudgetState {
  steps: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  startTime: number;
  abortController: AbortController;
}

export function createBudgetEnforcer(budget?: RuntimeBudget): {
  state: BudgetState;
  /** Check and increment step count. Throws if exceeded. */
  checkStep(): void;
  /** Record token usage (best-effort). Returns true if over budget. */
  recordTokens(input: number, output: number): boolean;
  /** Check if timed out. */
  isTimedOut(): boolean;
  /** Get the AbortSignal for fetch calls. */
  signal(): AbortSignal;
  /** Clean up timer resources. */
  dispose(): void;
} {
  const state: BudgetState = {
    steps: 0,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    startTime: Date.now(),
    abortController: new AbortController(),
  };

  let timeoutHandle: ReturnType<typeof setTimeout> | null = null;

  // Set up hard timeout
  if (budget?.timeoutMs) {
    timeoutHandle = setTimeout(() => {
      state.abortController.abort(
        new Error(`Runtime budget exceeded: timeout ${budget.timeoutMs}ms`)
      );
    }, budget.timeoutMs);
  }

  return {
    state,

    checkStep() {
      state.steps++;
      if (budget?.maxSteps && state.steps > budget.maxSteps) {
        throw new Error(
          `Runtime budget exceeded: ${state.steps} steps (max: ${budget.maxSteps})`
        );
      }
    },

    recordTokens(input: number, output: number): boolean {
      state.totalInputTokens += input;
      state.totalOutputTokens += output;
      if (budget?.maxTokens) {
        return (
          state.totalInputTokens + state.totalOutputTokens > budget.maxTokens
        );
      }
      return false;
    },

    isTimedOut(): boolean {
      if (!budget?.timeoutMs) return false;
      return Date.now() - state.startTime > budget.timeoutMs;
    },

    signal() {
      return state.abortController.signal;
    },

    dispose() {
      if (timeoutHandle) {
        clearTimeout(timeoutHandle);
        timeoutHandle = null;
      }
    },
  };
}
