/**
 * The agent loop's phases as data.
 *
 * `preparing → awaiting-pre-step → requesting-model → reviewing →
 * running-tools → deciding → … → finalizing → stopped`, with `suspended` as
 * the other terminal. The loop body keeps its shape; it calls `enter` at each
 * phase boundary, and an illegal move throws. That is a programming error in
 * the loop, never something a model or a plugin can cause.
 */

import type { LoopStop } from "@covel/shared";

export type LoopPhase =
  | "preparing"
  | "awaiting-pre-step"
  | "requesting-model"
  | "reviewing"
  | "running-tools"
  | "deciding"
  | "finalizing"
  | "stopped"
  | "suspended";

/** Where each phase may go next. */
export const LEGAL_TRANSITIONS: Readonly<
  Record<LoopPhase, readonly LoopPhase[]>
> = {
  // Fresh and resumed loops start a step, or stop at once when the step limit
  // or the deadline is already reached.
  preparing: ["awaiting-pre-step", "finalizing", "stopped"],
  // A successful PreStep stop may still need an output repair.
  "awaiting-pre-step": ["requesting-model", "finalizing", "stopped"],
  "requesting-model": ["reviewing"],
  // Tool calls run and prose is decided. A rejected draft starts the next
  // step, or ends at the loop's step limit or deadline.
  reviewing: [
    "running-tools",
    "deciding",
    "awaiting-pre-step",
    "finalizing",
    "stopped",
  ],
  // A suspend tool ends the loop from inside the batch.
  "running-tools": ["deciding", "suspended"],
  // Continue with another step, run the finalizer, or stop.
  deciding: ["awaiting-pre-step", "finalizing", "stopped"],
  finalizing: ["stopped"],
  stopped: [],
  suspended: [],
} as const;

export interface LoopState {
  readonly phase: LoopPhase;
  /** Steps started so far, the finalizer excluded. */
  steps: number;
  /** How the loop ended; set once it has stopped. */
  stop: LoopStop | undefined;
  enter(next: LoopPhase): void;
}

export function createLoopState(): LoopState {
  let phase: LoopPhase = "preparing";
  return {
    get phase() {
      return phase;
    },
    steps: 0,
    stop: undefined,
    enter(next) {
      if (!LEGAL_TRANSITIONS[phase].includes(next))
        throw new Error(`illegal agent-loop transition ${phase} -> ${next}`);
      phase = next;
    },
  };
}
