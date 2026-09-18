import { buildSessionContextSnapshot } from "@covel/context";
import { DEFAULT_LOCALE, type RuntimeResult } from "@covel/shared";
import type { TurnExecutorDeps } from "../turn-executor/turn-executor-types.js";
import type { StoreTransaction } from "@covel/store/contracts";
import {
  buildPostTurnMemoryUpdate,
  dispatchMemoryUpdate,
} from "../turn-executor/post-turn-memory.js";
import { emitSubEvent } from "../turn-executor/turn-runtime-helpers.js";
import { saveAutoSnapshot } from "../snapshot/auto-snapshot.js";
import { awaitPendingMemory } from "../turn-executor/memory-barrier.js";
import {
  finalizeExecution,
  type FinalizeExecutionArgs,
  type FinalizeExecutionOutcome,
} from "./finalize-execution.js";

/** The caller owns the session lock and execution/continuation claim. */
export type ExecutionCompletion =
  | {
      readonly kind: "turn";
      readonly turnId: string;
      readonly durationMs: number;
    }
  | {
      readonly kind: "resume";
      readonly turnId: string;
      readonly suspensionId: string;
      readonly pluginId: string;
      readonly runtimeId: string;
    }
  | { readonly kind: "detached"; readonly turnId: string };

export interface CommitExecutionArgs extends Omit<
  FinalizeExecutionArgs,
  "results"
> {
  readonly results: readonly RuntimeResult[];
  readonly completion: ExecutionCompletion;
  readonly memorySystem?: TurnExecutorDeps["memorySystem"];
  readonly capabilityPluginIds?: TurnExecutorDeps["capabilityPluginIds"];
  /** Transport delivery precedes the checkpoint and completion notification. */
  readonly onFinalized?: (
    outcome: FinalizeExecutionOutcome,
  ) => void | Promise<void>;
}

export interface CommitExecutionOutcome extends FinalizeExecutionOutcome {
  /** A checkpoint failure never changes an already durable commit to a failure. */
  readonly snapshotFailed: boolean;
}

/**
 * Host entry point for committing player, manual, background and resumed work.
 * Call once under the session lock; this is not an execution deduplication API.
 * Durable writes share finalizeExecution's transaction. Post-commit delivery,
 * checkpoints and memory are isolated so their failures cannot invite replay.
 */
export async function commitExecution(
  args: CommitExecutionArgs,
): Promise<CommitExecutionOutcome> {
  // Detached work can return after a newer turn started memory extraction.
  // Drain under the caller's lock before writing proposals, not just before
  // snapshotting, so an older extraction cannot overwrite this commit's tools.
  try {
    await awaitPendingMemory(
      args.memorySystem?.updater,
      args.sessionId,
      args.signal,
    );
  } catch (error) {
    if (!args.signal?.aborted) throw error;
    // The shared finalizer still owns rollback and execution/job settlement.
  }
  const stage = args.memorySystem?.updater.stageAfterTurn;
  let stagedInput: ReturnType<typeof buildPostTurnMemoryUpdate>;
  const outcome = await finalizeExecution(
    stage
      ? {
          ...args,
          extraInTx: async (tx) => {
            await args.extraInTx?.(tx);
            stagedInput = await prepareCommittedMemory(args, tx);
            if (stagedInput) await stage(tx, stagedInput);
          },
        }
      : args,
  );
  try {
    await args.onFinalized?.(outcome);
  } catch (error) {
    console.warn("[commit-execution] outcome delivery failed:", error);
  }
  if (outcome.status !== "committed") {
    return { ...outcome, snapshotFailed: false };
  }

  const { completion, store, sessionId, eventBus } = args;
  const suspended = args.results.some(
    (result) => result.status === "suspended",
  );
  if (completion.kind === "resume" && !suspended) {
    try {
      emitSubEvent(eventBus, "game", "turn.resumed", sessionId, {
        sessionId,
        turnId: completion.turnId,
        suspensionId: completion.suspensionId,
        pluginId: completion.pluginId,
        runtimeId: completion.runtimeId,
      });
    } catch (error) {
      console.warn("[commit-execution] resume notification failed:", error);
    }
  }

  let snapshotFailed = false;
  try {
    await saveAutoSnapshot({
      store,
      sessionId,
      turnId: completion.turnId,
      eventBus,
      force: completion.kind === "resume",
    });
  } catch (error) {
    snapshotFailed = true;
    console.warn(
      `[commit-execution] auto snapshot failed for ${sessionId}:`,
      error,
    );
  }

  if (!suspended && completion.kind !== "detached") {
    if (completion.kind === "turn") {
      try {
        emitSubEvent(eventBus, "game", "turn.completed", sessionId, {
          sessionId,
          turnId: completion.turnId,
          durationMs: completion.durationMs,
        });
      } catch (error) {
        console.warn(
          "[commit-execution] completion notification failed:",
          error,
        );
      }
    }
    try {
      if (stage && stagedInput) {
        void args.memorySystem?.updater
          .awaitPending?.(sessionId)
          .catch((error: unknown) => {
            console.warn("[commit-execution] memory recovery failed:", error);
          });
      } else if (!stage) {
        const input = await prepareCommittedMemory(args, args.store);
        if (input && args.memorySystem)
          dispatchMemoryUpdate(args.memorySystem, input);
      }
    } catch (error) {
      console.warn("[commit-execution] memory preparation failed:", error);
    }
  }
  return { ...outcome, snapshotFailed };
}

async function prepareCommittedMemory(
  args: CommitExecutionArgs,
  store: StoreTransaction,
): Promise<ReturnType<typeof buildPostTurnMemoryUpdate>> {
  const { memorySystem, sessionId, completion, capabilityPluginIds } = args;
  if (
    !memorySystem ||
    completion.kind === "detached" ||
    args.results.some((result) => result.status === "suspended")
  )
    return;
  const storyIds = new Set(
    args.runtimes
      .filter((runtime) => runtime.outputKind === "story")
      .map((runtime) => runtime.name),
  );
  if (
    !args.results.some(
      (result) =>
        result.status === "success" &&
        result.turnId === completion.turnId &&
        storyIds.has(result.runtimeId),
    )
  )
    return;

  const session = await store.getSession(sessionId);
  const locale = session?.locale ?? DEFAULT_LOCALE;
  const coreMemoryBlocks = await memorySystem.manager.loadBlocks(
    sessionId,
    await store.listWorkingMemory(sessionId),
  );
  const sessionContext = await buildSessionContextSnapshot(store, sessionId, {
    locale,
    worldId: session?.worldId ?? undefined,
    worldDataPluginId: capabilityPluginIds?.worldDataPluginId,
    personaPluginId: capabilityPluginIds?.personaPluginId,
    turnNumber: session?.completedPlayerTurns ?? 0,
    coreMemoryBlocks,
  });
  return buildPostTurnMemoryUpdate({
    input: {
      sessionId,
      turnId: completion.turnId,
      locale,
    },
    turnResult: { runtimeResults: args.results },
    runtimes: args.runtimes,
    deps: { memorySystem, emitter: args.emitter },
    coreMemoryBlocks,
    sessionContext,
  });
}
