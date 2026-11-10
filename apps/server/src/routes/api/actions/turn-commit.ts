/**
 * Turn phase 4, under the settled session lock: commit an executed turn.
 *
 * One transaction saves the execution's writes with the player's input rows,
 * the follow-up work the turn queued (deferred stage jobs, event followers,
 * jobs a replaced suspension released) and the player's interjections. The
 * commit settles the execution whatever its outcome; its finalized events go
 * to the stream before the lock is released. The jobs it queued are returned
 * for announcement after the lock.
 */

import type { StoreTransaction } from "@covel/store";
import {
  applyIsolatedRuntimes,
  type ExecutedTurn,
  type TraceRecorder,
} from "@covel/runtime";
import {
  PLAYER_ABORT_REASON,
  type ExecutionAdvanceStopReason,
} from "@covel/shared";
import {
  NO_FOLLOW_UPS,
  queueCommitFollowUps,
  queueReleasedRuntimeJobs,
} from "../commit-envelope.js";
import { commitExecution } from "../commit-execution.js";
import { resolveMediaImageFlow } from "../media-image-flow.js";
import type { QueuedRuntimeJob } from "../plugin-rpc/runtime-job-enqueue.js";
import {
  PLAYER_INTERJECTION_SOURCE,
  type TurnInterjection,
} from "../turn-control.js";
import { committedAdvanceDecision } from "./auto-advance.js";
import { droppedRunPayloads } from "./dropped-runs.js";
import { settleRuntimeRetry } from "./runtime-retry.js";
import type { PreparedTurn } from "./turn-preparation.js";
import type { TurnPhase } from "./turn-request.js";
import type { StartedTurn } from "./turn-start.js";

/** A turn whose execution the commit settled, committed or not. */
export interface CommittedTurn {
  readonly stopped: false;
  /** The execution's result; a stopped turn that did not commit is aborted. */
  readonly result: ExecutedTurn["result"];
  readonly trace: TraceRecorder;
  readonly committed: boolean;
  readonly commitError: string | undefined;
  /** Some of the commit's events were not published, or its story unread. */
  readonly fanOutFailed: boolean;
  readonly wasPreGamePending: boolean;
  /** Why no round may follow, read from the committed story. */
  readonly stopReason: ExecutionAdvanceStopReason | undefined;
  /** A `retry_turn` that ran again from the player's recorded input. */
  readonly replaysPlayerInput: boolean;
  /** Jobs the commit queued, empty unless it committed. */
  readonly queuedRuntimeJobs: readonly QueuedRuntimeJob[];
  readonly followerJobs: readonly QueuedRuntimeJob[];
}

export async function commitExecutedTurn(
  phase: TurnPhase,
  prepared: PreparedTurn,
  started: StartedTurn,
  execution: ExecutedTurn,
): Promise<CommittedTurn> {
  const { request, stream, ledger } = phase;
  const { store, eventBus, mediaStore, body, host } = request;
  const { type, sessionId, model } = body;
  const { control } = ledger;
  const { playerInput, retryPlan, activeRuntimes, commitSignal } = prepared;
  const {
    session: effectiveSession,
    wasPreGamePending,
    playerInputWrites,
    trace,
    emitter,
    userSettings,
  } = started;
  const { result } = execution;
  const hookPipeline = host.hookPipeline;
  const releasedJobs: QueuedRuntimeJob[] = [];
  // What the landed transaction queued; a retried one replaces it.
  let followUps = NO_FOLLOW_UPS;
  // Interjections the player sent during the turn are part of it: the
  // turn's commit saves them to the prompt history (after the player's
  // message, at the moment a model call read them; one no call read
  // comes after the turn's output) and to the chat log. A turn that
  // does not commit keeps neither.
  const saveInterjections = async (
    tx: StoreTransaction,
    interjections: readonly TurnInterjection[],
  ) => {
    const savedAt = new Date().toISOString();
    for (const [index, interjection] of interjections.entries()) {
      const createdAt = interjection.readAt ?? savedAt;
      await tx.appendTurnMessage({
        id: crypto.randomUUID(),
        sessionId,
        turnId: result.turnId,
        sourceType: PLAYER_INTERJECTION_SOURCE,
        role: "user",
        content: interjection.content,
        order: index,
        createdAt,
      });
      await tx.addMessage({
        id: crypto.randomUUID(),
        sessionId,
        role: "user",
        content: interjection.content,
        metadata: { turnId: result.turnId, steered: true },
        createdAt,
      });
    }
  };
  const correctedRuns = new Set<string>();
  const imageFlowRuntimeIds = (
    await resolveMediaImageFlow(store, host.pluginExtensions, sessionId)
  )?.assetRuntimeIds;
  // From here the commit settles the execution, whatever its outcome.
  ledger.handExecutionToCommit();
  const outcome = await commitExecution({
    onRuntimeCorrection: (type, payload) => {
      if (typeof payload.runId === "string") correctedRuns.add(payload.runId);
      return stream.write(
        type,
        payload,
        typeof payload.turnId === "string" ? payload.turnId : stream.turnId,
      );
    },
    memorySystem: host.memorySystem,
    imageFlowRuntimeIds,
    completion: {
      kind: "turn",
      turnId: result.turnId,
      durationMs: result.durationMs,
    },
    onFinalized: async (outcome) => {
      ledger.markCommitSettled();
      for (const evt of outcome.events) {
        // Emit using CovelEventType directly.
        await stream.write(evt.type, {
          ...evt.payload,
          runtimeId: evt.source.runtimeId,
          pluginId: evt.source.pluginId,
        });
      }
      // Commit failures are surfaced as `proposal.failed` SSE events; any
      // failure withholds the completion barrier below (turn.completed,
      // memory ingestion, auto-snapshot success signal). A
      // story-attached operation that failed alone is not an
      // execution failure: the fixed `operation.failed` notice
      // below tells the player instead.
      for (const fp of outcome.failedProposals) {
        if (fp.operationId !== undefined) continue;
        await stream.write("proposal.failed", {
          proposalId: fp.proposal.id,
          proposalType: fp.proposal.type,
          runtimeId: fp.proposal.source.runtimeId,
          pluginId: fp.proposal.source.pluginId,
          error: fp.error,
        });
      }
      const failedOperations = outcome.operations.filter(
        (operation) => operation.status === "failed",
      ).length;
      if (outcome.status === "committed" && failedOperations > 0) {
        const payload = {
          sessionId,
          turnId: result.turnId,
          count: failedOperations,
          messages: outcome.operationFailureMessages ?? [],
        };
        await emitter.emit("operation.failed", payload);
        await stream.write("operation.failed", payload);
      }
      // A run already streamed as completed whose writes were
      // dropped at commit: show the saved result, not the run.
      for (const payload of droppedRunPayloads(
        result,
        outcome.isolatedRuntimes,
      )) {
        if (correctedRuns.has(payload.runId)) continue;
        await emitter.emit("runtime.failed", payload);
        await stream.write("runtime.failed", payload);
      }
    },
    signal: commitSignal,
    store,
    execution,
    // A suspension this turn saves replaces an older one of the same
    // runtime; when that ends the older turn, its held-back jobs are
    // queued here and announced with this turn's own.
    enqueueReleasedJobsInTx: async (tx, jobs) => {
      releasedJobs.push(
        ...(await queueReleasedRuntimeJobs(
          tx,
          {
            sessionId,
            session: effectiveSession,
            activeRuntimes,
            locale: request.locale,
            ...(userSettings ? { userSettings } : {}),
            credentials: host.credentials,
          },
          jobs,
        )),
      );
    },
    extraInTx: async (tx, isolation) => {
      if (playerInputWrites) {
        await tx.commitPlayerInputMessage(playerInputWrites.message);
        await tx.saveInteractionRecord(playerInputWrites.interaction);
      }
      // Deferred stage jobs and background followers (e.g. image
      // generation) are queued with the writes they react to, so a
      // rolled-back turn queues none, and none derived from a
      // runtime whose writes were dropped.
      followUps = await queueCommitFollowUps(tx, {
        sessionId,
        activeRuntimes,
        locale: request.locale,
        ...(model ? { modelOverride: model } : {}),
        ...(userSettings ? { userSettings } : {}),
        credentials: host.credentials,
        isolation,
        turnResult: result,
      });
      await saveInterjections(tx, control.closeInterjections());
    },
    ...(hookPipeline ? { hookPipeline } : {}),
    eventBus,
    emitter,
    // MediaRef canonicalization / ownership for published export values.
    ...(mediaStore ? { mediaStore } : {}),
  });
  const committed = outcome.status === "committed";
  stream.setRetryScope(
    settleRuntimeRetry(
      retryPlan,
      applyIsolatedRuntimes(result.runtimeResults, outcome.isolatedRuntimes),
      committed,
    ),
  );
  const proposalErrors = outcome.failedProposals
    .map((failure) => failure.error)
    .filter(Boolean)
    .join("; ");
  const commitError = committed
    ? undefined
    : outcome.error || proposalErrors || "Execution commit failed";

  let stopReason: ExecutionAdvanceStopReason | undefined;
  let decisionReadFailed = false;
  try {
    stopReason = wasPreGamePending
      ? "no-eligible-story"
      : await committedAdvanceDecision(store, sessionId, outcome);
  } catch (error) {
    // A failed observation cannot undo the transaction just committed.
    console.warn("[actions] committed story decision could not be read", error);
    decisionReadFailed = true;
    stopReason = "prerequisite-unavailable";
  }
  return {
    stopped: false as const,
    result:
      !committed && control.signal.aborted
        ? { ...result, abortReason: PLAYER_ABORT_REASON }
        : result,
    trace,
    committed,
    commitError,
    fanOutFailed: outcome.fanOutFailed === true || decisionReadFailed,
    wasPreGamePending,
    stopReason,
    // A `retry_turn` that ran again from the player's recorded input.
    replaysPlayerInput: type === "retry_turn" && playerInput !== undefined,
    queuedRuntimeJobs: committed
      ? [...releasedJobs, ...followUps.runtimeJobs]
      : [],
    followerJobs: committed ? followUps.followerJobs : [],
  };
}
