/**
 * What one action request keeps across the turns it runs (the player's turn,
 * the opening continuation, auto-advanced rounds) and the reporting built on
 * it: round completion, advancement, the plugin fault group and the stopped
 * opening marker.
 *
 * Turn phases change it only through its methods. Its flags decide how a
 * failure settles: `uncommittedExecution` and `commitStatusSettled` tell the
 * request's failure path which execution is still unsettled.
 */

import type { EventBus } from "@covel/events";
import {
  createTraceRecorder,
  type ExecutedTurn,
  type FaultTransition,
} from "@covel/runtime";
import {
  PLAYER_ABORT_REASON,
  type ExecutionAdvancePayload,
  type ExecutionAdvanceStopReason,
  type RuntimeManifest,
  type ValidatedActionRequest,
} from "@covel/shared";
import type { DataStore } from "@covel/store";
import { pluginFaultHost } from "../plugin-faults.js";
import type { ActionRequestControl } from "../turn-control.js";
import type { ActionStream } from "./action-stream.js";
import { createAdvanceRoot } from "./auto-advance.js";
import { recoveryAction } from "./execution-recovery.js";

export type AdvanceRoot = ReturnType<typeof createAdvanceRoot>;

/** How one turn of the request ended, as its round and the stream report it. */
export interface TurnOutcome {
  readonly resultCount: number;
  readonly durationMs: number;
  readonly abortReason?: string;
  readonly committed: boolean;
  readonly commitError?: string;
  readonly fanOutFailed: boolean;
  /** The opening continuation follows this turn. */
  readonly continues: boolean;
  readonly stopReason?: ExecutionAdvanceStopReason;
  readonly notStarted?: boolean;
}

/** A turn the player stopped: it committed nothing. */
export const STOPPED_OUTCOME: TurnOutcome = {
  resultCount: 0,
  durationMs: 0,
  abortReason: PLAYER_ABORT_REASON,
  committed: false,
  fanOutFailed: false,
  continues: false,
  stopReason: "player-stop",
};

/** The last turn that settled, with what the final stream event reports. */
export interface SettledTurn {
  readonly turnId: string;
  readonly runtimeCount: number;
  readonly outcome: TurnOutcome;
}

export interface RequestLedgerOptions {
  readonly store: DataStore;
  readonly stream: ActionStream;
  /** Registered for this request after its admission. */
  readonly control: ActionRequestControl;
  /** The session-scoped bus the fault group publishes on. */
  readonly eventBus: EventBus;
  /** The action requested; a stopped opening records its recovery. */
  readonly request: Pick<ValidatedActionRequest, "type" | "payload">;
}

export interface RequestLedger {
  readonly root: AdvanceRoot;
  readonly control: ActionRequestControl;
  /** The runtimes active for the latest turn, read under the lock. */
  readonly activeRuntimes: readonly RuntimeManifest[];
  /** The current turn recorded `turn.started`. */
  readonly hasStartedTurn: boolean;
  /** Some turn of this request recorded `turn.started`. */
  readonly requestStarted: boolean;
  /** The current turn's execution artifact had its commitStatus settled. */
  readonly commitStatusSettled: boolean;
  /** The current turn's execution until it reaches the commit. */
  readonly uncommittedExecution: ExecutedTurn | undefined;
  /** The last turn that started (or the stopped opening recorded). */
  readonly lastActualTurnId: string;
  readonly lastSettled: SettledTurn | undefined;
  /** Some settled step's events were not published: clients must resync. */
  readonly resyncRequired: boolean;
  /** Why an auto-advanced round did not start, when it refused itself. */
  readonly autoStartRefusal: ExecutionAdvanceStopReason | undefined;

  /** Forget the previous turn's settlement and round state. */
  resetTurn(): void;
  refuseAutoStart(reason: ExecutionAdvanceStopReason): void;
  useActiveRuntimes(runtimes: readonly RuntimeManifest[]): void;
  /** Group this request's plugin faults; once per request. */
  openFaultGroup(): void;
  /** Make `turnId` the turn the stream and the request's reports name. */
  enterTurn(turnId: string): void;
  markTurnStarted(): void;
  holdExecution(execution: ExecutedTurn): void;
  /** From here the commit settles the execution, whatever its outcome. */
  handExecutionToCommit(): void;
  markCommitSettled(): void;
  /** The current turn settled with `outcome`. */
  recordSettled(outcome: TurnOutcome): void;

  /** Run a step after the turn settled; a failure only asks for a resync. */
  afterSettlement(step: string, run: () => Promise<unknown>): Promise<void>;
  publishAdvance(progress: ExecutionAdvancePayload): Promise<void>;
  /** Report the current turn's round once, when it started. */
  reportRound(outcome: TurnOutcome): Promise<void>;
  recordStoppedContinuation(stoppedTurnId: string): Promise<void>;
  closeFaultGroup(): Promise<void>;
}

/** Steps after a commit are diagnostics or notices: a failure is only logged. */
async function afterCommit(
  sessionId: string,
  step: string,
  run: () => Promise<unknown>,
): Promise<boolean> {
  try {
    await run();
    return true;
  } catch (error) {
    console.warn(
      `[actions] ${step} failed for ${sessionId} after the turn settled:`,
      error,
    );
    return false;
  }
}

export function createRequestLedger(
  options: RequestLedgerOptions,
): RequestLedger {
  const { store, stream, control, eventBus, request } = options;
  const { requestId, sessionId, traceId } = stream;
  const root = createAdvanceRoot(requestId);
  const faults = pluginFaultHost(store);
  let closeFaultGroup: (() => FaultTransition[]) | undefined;
  let roundReported = false;
  let accumulatedResync = false;
  let roundResync = false;
  let lastActualTurnId: string = stream.turnId;
  let autoStartRefusal: ExecutionAdvanceStopReason | undefined;
  // Whether this turn's execution artifact had its commitStatus settled.
  // Consulted by the request's failure path: an error after the artifact was
  // persisted but before settlement is a known failure, not a crash, so the
  // row must not be left `pending` forever.
  let commitStatusSettled = false;
  // The current turn's execution until it reaches the commit, which then
  // settles it; the failure path abandons one that never got there.
  let uncommittedExecution: ExecutedTurn | undefined;
  let hasStartedTurn = false;
  let requestStarted = false;
  // Populated from the authoritative live session after taking the lock. Do
  // not reconcile process-local activations from the stale pre-lock snapshot:
  // a queued request from incarnation A must not overwrite incarnation B's
  // registry before its ABA check rejects.
  let activeRuntimes: readonly RuntimeManifest[] = [];
  let lastSettled: SettledTurn | undefined;

  const afterSettlement = async (step: string, run: () => Promise<unknown>) => {
    if (!(await afterCommit(sessionId, step, run))) {
      accumulatedResync = true;
      roundResync = true;
    }
  };

  return {
    root,
    control,
    get activeRuntimes() {
      return activeRuntimes;
    },
    get hasStartedTurn() {
      return hasStartedTurn;
    },
    get requestStarted() {
      return requestStarted;
    },
    get commitStatusSettled() {
      return commitStatusSettled;
    },
    get uncommittedExecution() {
      return uncommittedExecution;
    },
    get lastActualTurnId() {
      return lastActualTurnId;
    },
    get lastSettled() {
      return lastSettled;
    },
    get resyncRequired() {
      return accumulatedResync;
    },
    get autoStartRefusal() {
      return autoStartRefusal;
    },

    resetTurn() {
      commitStatusSettled = false;
      uncommittedExecution = undefined;
      hasStartedTurn = false;
      roundReported = false;
      roundResync = false;
    },
    refuseAutoStart(reason) {
      autoStartRefusal = reason;
    },
    useActiveRuntimes(runtimes) {
      activeRuntimes = runtimes;
    },
    openFaultGroup() {
      closeFaultGroup ??= faults?.latch.beginGroup(sessionId, root.rootId);
    },
    enterTurn(turnId) {
      stream.enterTurn(turnId);
      lastActualTurnId = turnId;
    },
    markTurnStarted() {
      hasStartedTurn = true;
      requestStarted = true;
    },
    holdExecution(execution) {
      uncommittedExecution = execution;
    },
    handExecutionToCommit() {
      uncommittedExecution = undefined;
    },
    markCommitSettled() {
      commitStatusSettled = true;
    },
    recordSettled(outcome) {
      accumulatedResync ||= outcome.fanOutFailed;
      lastSettled = {
        turnId: stream.turnId,
        runtimeCount: activeRuntimes.length,
        outcome,
      };
    },

    afterSettlement,
    async publishAdvance(progress) {
      if (!requestStarted) return;
      control.setAdvance(progress);
      await afterSettlement("recording advancement", () =>
        store.addTraceEvent({
          id: crypto.randomUUID(),
          sessionId,
          turnId: lastActualTurnId,
          traceId,
          type: "execution.advance",
          payload: progress,
          createdAt: new Date().toISOString(),
        }),
      );
      await stream.write("execution.advance", { ...progress });
    },
    async reportRound(outcome) {
      if (!hasStartedTurn || roundReported) return;
      roundReported = true;
      const completed = {
        requestId,
        rootId: root.rootId,
        turnId: stream.turnId,
        round: root.round,
        limit: root.limit,
        runtimeCount: activeRuntimes.length,
        resultCount: outcome.resultCount,
        durationMs: outcome.durationMs,
        committed: outcome.committed,
        ...(outcome.commitError ? { error: outcome.commitError } : {}),
        ...(outcome.abortReason ? { abortReason: outcome.abortReason } : {}),
        ...(outcome.fanOutFailed || roundResync
          ? { resyncRequired: true }
          : {}),
      };
      await afterSettlement("recording round completion", () =>
        store.addTraceEvent({
          id: crypto.randomUUID(),
          sessionId,
          turnId: stream.turnId,
          traceId,
          type: "execution.round.completed",
          payload: completed,
          createdAt: new Date().toISOString(),
        }),
      );
      await stream.write("execution.round.completed", completed);
    },
    // The opening the player stopped before it began is recorded as a stopped
    // continuation turn: nothing of it is stored, and the execution status
    // offers to run it (`retry_turn` as a continuation).
    async recordStoppedContinuation(stoppedTurnId) {
      lastActualTurnId = stoppedTurnId;
      await afterSettlement("recording the stopped opening", async () => {
        const recorder = createTraceRecorder(
          store,
          sessionId,
          stoppedTurnId,
          traceId,
        );
        await recorder.turnStarted({
          runtimeCount: 0,
          requestId,
          origin: "continuation",
          ...(root.logicalTurn !== undefined
            ? { advancement: root.provenance("opening") }
            : {}),
          recoveryAction: recoveryAction(request.type, request.payload, true),
        });
        await recorder.turnCompleted({
          durationMs: 0,
          resultCount: 0,
          committed: false,
          abortReason: PLAYER_ABORT_REASON,
        });
      });
    },
    async closeFaultGroup() {
      const close = closeFaultGroup;
      closeFaultGroup = undefined;
      if (close)
        await afterSettlement("closing fault group", async () => {
          await faults?.publish(close(), undefined, eventBus, {
            traceId,
            turnId: lastActualTurnId,
          });
        });
    },
  };
}
