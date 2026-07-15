import {
  buildSessionContextSnapshot,
  type SessionContextSnapshot,
  type WorkingMemoryEntry,
} from "@covel/context";
import type { SessionSummaryRecord, WorkingMemoryRecord } from "@covel/store";
import type { TurnInput } from "@covel/shared";
import type { TurnExecutorDeps } from "./turn-executor-types.js";
import type { CoreMemoryBlock } from "./session-state.js";

export async function loadSessionSummaries(args: {
  readonly input: TurnInput;
  readonly deps: TurnExecutorDeps;
}): Promise<readonly SessionSummaryRecord[]> {
  const { input, deps } = args;
  if (!deps.store) return [];
  return [...(await deps.store.listSessionSummaries(input.sessionId))];
}

export interface LoadedWorkingMemory {
  readonly entries: readonly WorkingMemoryEntry[];
  /**
   * The raw records backing `entries`, threaded into the core-memory manager
   * so the turn reads `listWorkingMemory` once instead of three times (R-13).
   * `undefined` when the read failed or no store is wired — the manager then
   * falls back to its own read rather than mistaking an error for "empty"
   * (which would blank real blocks via initializeDefaults).
   */
  readonly records?: readonly WorkingMemoryRecord[];
}

export async function loadWorkingMemory(args: {
  readonly input: TurnInput;
  readonly deps: TurnExecutorDeps;
}): Promise<LoadedWorkingMemory> {
  const { input, deps } = args;
  if (!deps.store || typeof deps.store.listWorkingMemory !== "function") {
    return { entries: [] };
  }

  try {
    const records = await deps.store.listWorkingMemory(input.sessionId);
    return {
      entries: records.map((r) => ({
        scope: r.scope,
        key: r.key,
        value: r.value,
      })),
      records,
    };
  } catch {
    return { entries: [] };
  }
}

export async function loadCoreMemoryBlocks(args: {
  readonly input: TurnInput;
  readonly deps: TurnExecutorDeps;
  readonly workingMemoryRecords?: readonly WorkingMemoryRecord[];
}): Promise<readonly CoreMemoryBlock[]> {
  const { input, deps, workingMemoryRecords } = args;
  if (!deps.memorySystem) return [];

  try {
    await deps.memorySystem.manager.initializeDefaults(
      input.sessionId,
      workingMemoryRecords,
    );
    return await deps.memorySystem.manager.loadBlocks(
      input.sessionId,
      workingMemoryRecords,
    );
  } catch {
    return [];
  }
}

export async function refreshSessionContextSnapshot(args: {
  readonly input: TurnInput;
  readonly deps: TurnExecutorDeps;
  readonly turnNumber: number;
  readonly sessionSummaries: readonly SessionSummaryRecord[];
  readonly coreMemoryBlocks: readonly CoreMemoryBlock[];
}): Promise<SessionContextSnapshot | undefined> {
  const { input, deps, turnNumber, sessionSummaries, coreMemoryBlocks } = args;
  if (!deps.store) return undefined;

  try {
    const sessionRecord = await deps.store.getSession(input.sessionId);
    return await buildSessionContextSnapshot(deps.store, input.sessionId, {
      locale: input.locale ?? "zh-CN",
      turnNumber,
      worldId: sessionRecord?.worldId ?? undefined,
      worldDataPluginId: deps.capabilityPluginIds?.worldDataPluginId,
      personaPluginId: deps.capabilityPluginIds?.personaPluginId,
      coreMemoryBlocks,
      summaries: sessionSummaries,
      playerMessage: input.playerMessage,
    });
  } catch (err) {
    console.warn(
      "[turn-executor] SessionContextSnapshot build failed:",
      err instanceof Error ? err.message : String(err),
    );
    return undefined;
  }
}
