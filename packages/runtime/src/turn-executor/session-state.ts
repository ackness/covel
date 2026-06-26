import type { RuntimeManifest, TurnInput } from "@covel/shared";
import { applyBranchReplyAcceptedCandidates } from "@covel/context";
import type { TurnMessageRecord } from "@covel/store";
import type { TurnExecutorDeps } from "../turn-executor-types.js";
import {
  runPreCompactionHook,
  runPostCompactionHook,
} from "../hooks/wire-helpers.js";

export interface TurnSessionCharacter {
  readonly name: string;
  readonly type: string;
  readonly description?: string;
  readonly fields?: Record<string, unknown>;
}

export interface TurnSessionMeta {
  readonly turnNumber: number;
  readonly characters: readonly TurnSessionCharacter[];
  readonly lastFormValues: Record<string, unknown> | undefined;
  readonly preGameCompleted: readonly string[];
}

export interface CoreMemoryBlock {
  readonly label: string;
  readonly content: string;
  readonly updatedAt: string;
}

export interface LoadedTurnSessionState {
  readonly messageHistory: readonly TurnMessageRecord[];
  readonly runtimeTriggerCounts: ReadonlyMap<string, number>;
  readonly sessionMeta: TurnSessionMeta;
  readonly sessionStatus: "active" | "paused" | "ended";
  readonly turnNumber: number;
}

export async function loadTurnSessionState(args: {
  readonly input: TurnInput;
  readonly deps: TurnExecutorDeps;
  readonly shouldAppendPlayerMessage: boolean;
}): Promise<LoadedTurnSessionState> {
  const { input, deps, shouldAppendPlayerMessage } = args;

  if (deps.memorySystem?.updater.awaitPending) {
    await deps.memorySystem.updater.awaitPending(input.sessionId);
  }

  let messageHistory: readonly TurnMessageRecord[] = [];
  if (deps.store) {
    messageHistory = await deps.store.listTurnMessages(input.sessionId);
  }

  const turnNumber = messageHistory.filter(
    (m) => m.sourceType === "player",
  ).length;

  if (deps.store && shouldAppendPlayerMessage) {
    await deps.store.appendTurnMessage({
      id: crypto.randomUUID(),
      sessionId: input.sessionId,
      turnId: input.turnId,
      sourceType: "player",
      role: "user",
      content: input.playerMessage,
      order: 0,
      createdAt: new Date().toISOString(),
    });
    messageHistory = await deps.store.listTurnMessages(input.sessionId);
  }

  if (deps.compactor && deps.store && shouldAppendPlayerMessage) {
    const freshMessages = await deps.store.listTurnMessages(input.sessionId);
    const hookOpts = {
      pipeline: deps.hookPipeline,
      sessionId: input.sessionId,
      turnId: input.turnId,
      eventBus: deps.eventBus,
      emitter: deps.emitter,
    };
    // PreCompaction veto gate — a plugin can keep full history this turn.
    const pre = await runPreCompactionHook(hookOpts, {
      messageCount: freshMessages.length,
    });
    if (!pre.skip) {
      const result = await deps.compactor.run(
        input.sessionId,
        "",
        freshMessages,
      );
      await runPostCompactionHook(hookOpts, {
        compacted: result.compacted,
        ...(result.summaryId ? { summaryId: result.summaryId } : {}),
      });
      messageHistory = await deps.store.listTurnMessages(input.sessionId);
    }
  }

  const runtimeTriggerCounts = buildRuntimeTriggerCounts(messageHistory);
  let sessionStatus: "active" | "paused" | "ended" = "active";
  let preGameCompleted: readonly string[] = [];
  let sessionCharacters: TurnSessionCharacter[] = [];
  let lastFormValues: Record<string, unknown> | undefined;

  if (deps.store) {
    const session = await deps.store.getSession(input.sessionId);
    if (session) {
      sessionStatus = session.status;
      preGameCompleted = session.preGameCompleted ?? [];
    }

    const charRecords = await deps.store.listCharacters(input.sessionId);
    sessionCharacters = charRecords.map((c) => ({
      name: c.name,
      type: c.type,
      description: c.description,
      fields: c.fields as Record<string, unknown>,
    }));

    try {
      const inputs = await deps.store.listPlayerInputs(input.sessionId);
      if (inputs.length > 0) {
        const latest = inputs[inputs.length - 1];
        if (latest?.values && typeof latest.values === "object") {
          lastFormValues = latest.values as Record<string, unknown>;
        }
      }
    } catch {
      // Non-critical: player inputs may not exist yet.
    }
  }

  return {
    messageHistory,
    runtimeTriggerCounts,
    sessionMeta: {
      turnNumber,
      characters: sessionCharacters,
      lastFormValues,
      preGameCompleted,
    },
    sessionStatus,
    turnNumber,
  };
}

export async function buildProjectedPromptHistory(args: {
  readonly input: TurnInput;
  readonly deps: TurnExecutorDeps;
  readonly messageHistory: readonly TurnMessageRecord[];
}): Promise<readonly TurnMessageRecord[]> {
  const { input, deps, messageHistory } = args;
  const promptHistory = messageHistory.filter(
    (msg) => !(msg.turnId === input.turnId && msg.sourceType === "player"),
  );

  // Prompt-history rewriter is discovered by the `prompt-history-rewriter`
  // capability (resolved server-side). When no such plugin is active for the
  // session, the projected history passes through unchanged — the framework
  // never assumes a specific plugin id.
  const rewriterPluginId =
    deps.capabilityPluginIds?.promptHistoryRewriterPluginId;
  if (!deps.store || !rewriterPluginId) return promptHistory;

  try {
    const rewriterTurns = await deps.store.listPluginData(
      input.sessionId,
      rewriterPluginId,
      "turns",
    );
    return applyBranchReplyAcceptedCandidates(promptHistory, rewriterTurns);
  } catch {
    return promptHistory;
  }
}

export function getPreGameRuntimeState(
  activeRuntimes: readonly RuntimeManifest[],
  preGameCompleted: readonly string[],
): {
  readonly preGameRuntimes: readonly RuntimeManifest[];
  readonly isPreGamePending: boolean;
} {
  const preGameRuntimes = activeRuntimes.filter(
    (rt) => rt.priority !== undefined && rt.priority <= 99,
  );
  return {
    preGameRuntimes,
    isPreGamePending: preGameRuntimes.some(
      (rt) => !preGameCompleted.includes(rt.name),
    ),
  };
}

export function buildRuntimeTriggerCounts(
  messageHistory: readonly TurnMessageRecord[],
): ReadonlyMap<string, number> {
  const counts = new Map<string, number>();
  for (const msg of messageHistory) {
    if (msg.sourceType === "runtime" && msg.sourceRuntimeId) {
      counts.set(
        msg.sourceRuntimeId,
        (counts.get(msg.sourceRuntimeId) ?? 0) + 1,
      );
    }
  }
  return counts;
}
