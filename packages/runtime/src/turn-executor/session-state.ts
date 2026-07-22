import type { RuntimeManifest, TurnInput } from "@covel/shared";
import { getRuntimeSpec } from "@covel/shared";
import { applyBranchReplyAcceptedCandidates } from "@covel/context";
import type { CoreMemoryBlockView } from "@covel/context";
import type { TurnMessageRecord } from "@covel/store";
import type { TurnExecutorDeps } from "./turn-executor-types.js";
import { isPreGamePriority } from "../schedule/scheduler.js";
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

/**
 * Runtime-local name for the authoritative core-memory block view.
 *
 * Aliases `@covel/context`'s {@link CoreMemoryBlockView} so the whole turn
 * pipeline threads a single named type — crucially one that carries the
 * schema-driven `displayName` (attached by `@covel/memory`'s manager) all the
 * way to `renderCoreMemory`. Previously this was a narrowed
 * `{ label; content; updatedAt }` shape, which erased `displayName` from the
 * type at the source: the value only survived by object reference, and any
 * explicit `.map()` reconstruction would silently drop it with no type error.
 * Keeping the name re-exported (rather than inlined) means `session-context.ts`
 * and `post-turn-memory.ts` keep their existing import unchanged.
 */
export type CoreMemoryBlock = CoreMemoryBlockView;

export interface LoadedTurnSessionState {
  readonly messageHistory: readonly TurnMessageRecord[];
  readonly runtimeTriggerCounts: ReadonlyMap<string, number>;
  readonly sessionMeta: TurnSessionMeta;
  readonly sessionStatus: "active" | "paused" | "ended";
  readonly turnNumber: number;
  /**
   * Persisted setup/main band, or undefined on a session written before the
   * scheduling redesign (the caller falls back to the legacy `preGameCompleted`
   * signal). Drives band selection and, via `logicalTurn`, scheduled cadence.
   */
  readonly phase?: "setup" | "playing";
  /** Committed main-loop player turns; `logicalTurn = completedPlayerTurns + 1`. */
  readonly completedPlayerTurns: number;
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

  // Bounded per-turn reads: counts come from a store-side aggregate over the
  // FULL log, while the in-memory history is only the uncompacted suffix —
  // the compacted prefix is represented by session summaries at prompt-build
  // time, so a long session never re-loads its whole history every turn.
  let messageHistory: readonly TurnMessageRecord[] = [];
  let turnNumber = 0;
  let runtimeTriggerCounts: ReadonlyMap<string, number> = new Map();
  if (deps.store) {
    const [uncompacted, stats] = await Promise.all([
      deps.store.listUncompactedTurnMessages(input.sessionId),
      deps.store.getTurnMessageStats(input.sessionId),
    ]);
    messageHistory = uncompacted;
    turnNumber = stats.playerMessageCount;
    runtimeTriggerCounts = new Map(Object.entries(stats.runtimeMessageCounts));
  }

  if (deps.store && shouldAppendPlayerMessage) {
    const playerMessage: TurnMessageRecord = {
      id: crypto.randomUUID(),
      sessionId: input.sessionId,
      turnId: input.turnId,
      sourceType: "player",
      role: "user",
      content: input.playerMessage,
      order: 0,
      createdAt: new Date().toISOString(),
    };
    await deps.store.appendTurnMessage(playerMessage);
    // The record just appended is the newest row, so concatenating locally is
    // equivalent to re-reading — and skips a second unbounded history scan on
    // the per-turn critical path (audit 2026-07-11 R-13).
    messageHistory = [...messageHistory, playerMessage];
  }

  if (deps.compactor && deps.store && shouldAppendPlayerMessage) {
    // Reuse messageHistory (set above after appending the player message) — no
    // write happens between there and here, so re-reading the full history was
    // a redundant unbounded scan on the per-turn critical path. The reload
    // below still runs after the compactor actually mutates history.
    const freshMessages = messageHistory;
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
        input.locale,
        deps.emitter?.traceId,
      );
      await runPostCompactionHook(hookOpts, {
        compacted: result.compacted,
        ...(result.summaryId ? { summaryId: result.summaryId } : {}),
      });
      messageHistory = await deps.store.listUncompactedTurnMessages(
        input.sessionId,
      );
    }
  }

  // triggerCounts already came from getTurnMessageStats above; the player
  // message appended this turn is a "player" row, so no runtime count moved.
  let sessionStatus: "active" | "paused" | "ended" = "active";
  let preGameCompleted: readonly string[] = [];
  let phase: "setup" | "playing" | undefined;
  let completedPlayerTurns = 0;
  let sessionCharacters: TurnSessionCharacter[] = [];
  let lastFormValues: Record<string, unknown> | undefined;

  if (deps.store) {
    const session = await deps.store.getSession(input.sessionId);
    if (session) {
      sessionStatus = session.status;
      preGameCompleted = session.preGameCompleted ?? [];
      phase = session.phase;
      completedPlayerTurns = session.completedPlayerTurns ?? 0;
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
    ...(phase !== undefined ? { phase } : {}),
    completedPlayerTurns,
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

/**
 * Resolve the setup-band runtimes and whether the session is still in the setup
 * band.
 *
 * The band decision reads the persisted `phase` when present (`setup` ⇒
 * pending, `playing` ⇒ not) — the scheduling-redesign source of truth. Sessions
 * written before `phase` existed (undefined) fall back to the legacy signal: any
 * setup runtime not yet in `preGameCompleted`. Turn entries backfill `phase`, so
 * the fallback only serves direct `executeTurn` callers (tests, programmatic).
 */
export function getPreGameRuntimeState(
  activeRuntimes: readonly RuntimeManifest[],
  preGameCompleted: readonly string[],
  phase?: "setup" | "playing",
): {
  readonly preGameRuntimes: readonly RuntimeManifest[];
  readonly isPreGamePending: boolean;
} {
  const preGameRuntimes = activeRuntimes.filter((rt) =>
    isPreGamePriority(getRuntimeSpec(rt).legacyOrder),
  );
  const isPreGamePending =
    phase !== undefined
      ? phase === "setup"
      : preGameRuntimes.some((rt) => !preGameCompleted.includes(rt.name));
  return { preGameRuntimes, isPreGamePending };
}
