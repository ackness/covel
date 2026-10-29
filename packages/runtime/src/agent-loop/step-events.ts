/**
 * `step.started` / `step.completed` trace events of the agent loop.
 *
 * One recorder per loop. A step opens when its model call is about to start
 * (right after `PreStep`) and closes exactly once: when the next step begins,
 * when the loop stops, or when an error leaves the loop. Closing at the next
 * step's start rather than in a `finally` keeps the loop body's shape, and
 * still orders every `tool.*` event of a step before its `step.completed`.
 *
 * The payloads carry no prompt, reply or tool argument. Notes carry a kind
 * and counts, never a tool name, so a concealed runtime keeps them.
 * A trace failure never fails a step.
 */

import type {
  LLMUsageSummary,
  StepCompletedPayload,
  StepNote,
  StepStartedPayload,
  StopReason,
} from "@covel/shared";
import type { TurnEmitter } from "../trace/turn-emitter.js";

export type { StepNote };

type StepToolChoice = StepStartedPayload["toolChoice"];

interface StepIdentity {
  readonly runtimeId: string;
  readonly pluginId: string;
  readonly turnId: string;
  readonly runId: string;
}

interface OpenStep {
  readonly step: number;
  readonly finalizer: boolean;
  readonly repair: boolean;
  readonly startedAt: number;
  finishReason?: string;
  usage?: LLMUsageSummary;
  readonly toolCalls: { name: string; success: boolean }[];
  readonly retries: { attempt: number; reason: string }[];
  readonly notes: StepNote[];
}

export interface StepRecorder {
  /** Emit `step.started` and open the step. Closes a step still open. */
  start(info: {
    readonly step: number;
    readonly maxSteps: number;
    readonly toolCount: number;
    readonly toolChoice: StepToolChoice;
    readonly finalizer?: boolean;
    readonly repair?: boolean;
  }): Promise<void>;
  /** Record a note on the open step; kept for the next step when none is open. */
  note(note: StepNote): void;
  retry(info: { readonly attempt: number; readonly reason: string }): void;
  responded(response: {
    readonly finishReason?: string;
    readonly usage?: LLMUsageSummary;
  }): void;
  toolCall(name: string, success: boolean): void;
  /**
   * Emit `step.completed` for the open step, if any. `thrown` drops the
   * usage: the step did not finish.
   */
  close(stopReason?: StopReason, options?: { thrown?: boolean }): Promise<void>;
  /** Whether a step is open. */
  readonly open: boolean;
}

export function createStepRecorder(
  emitter: TurnEmitter | undefined,
  identity: StepIdentity,
): StepRecorder {
  let current: OpenStep | undefined;
  // Notes made between steps (PreStep narrowing) belong to the next step.
  let pendingNotes: StepNote[] = [];

  async function emit(
    type: "step.started" | "step.completed",
    payload: StepStartedPayload | StepCompletedPayload,
  ): Promise<void> {
    if (!emitter) return;
    try {
      await emitter.emit(type, { ...payload });
    } catch {
      console.warn("[agent-loop] step event delivery failed", {
        type,
        runtimeId: identity.runtimeId,
        runId: identity.runId,
      });
    }
  }

  async function close(
    stopReason?: StopReason,
    options?: { thrown?: boolean },
  ): Promise<void> {
    const step = current;
    if (!step) return;
    current = undefined;
    await emit("step.completed", {
      ...identity,
      step: step.step,
      ...(step.finalizer ? { finalizer: true as const } : {}),
      ...(step.repair ? { repair: true as const } : {}),
      durationMs: Date.now() - step.startedAt,
      ...(step.finishReason !== undefined
        ? { finishReason: step.finishReason }
        : {}),
      ...(step.usage && !options?.thrown ? { usage: step.usage } : {}),
      toolCalls: step.toolCalls,
      retries: step.retries,
      notes: step.notes,
      ...(stopReason ? { stopReason } : {}),
    });
  }

  return {
    get open() {
      return current !== undefined;
    },
    async start(info) {
      await close();
      current = {
        step: info.step,
        finalizer: info.finalizer === true,
        repair: info.repair === true,
        startedAt: Date.now(),
        toolCalls: [],
        retries: [],
        notes: pendingNotes,
      };
      pendingNotes = [];
      await emit("step.started", {
        ...identity,
        step: info.step,
        ...(info.finalizer ? { finalizer: true as const } : {}),
        ...(info.repair ? { repair: true as const } : {}),
        maxSteps: info.maxSteps,
        toolCount: info.toolCount,
        toolChoice: info.toolChoice,
      });
    },
    note(note) {
      (current?.notes ?? pendingNotes).push(note);
    },
    retry(info) {
      current?.retries.push({ attempt: info.attempt, reason: info.reason });
    },
    responded(response) {
      if (!current) return;
      if (response.finishReason !== undefined)
        current.finishReason = response.finishReason;
      if (response.usage) current.usage = response.usage;
    },
    toolCall(name, success) {
      current?.toolCalls.push({ name, success });
    },
    close,
  };
}
