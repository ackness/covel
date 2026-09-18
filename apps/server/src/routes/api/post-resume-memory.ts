import { buildSessionContextSnapshot } from "@covel/context";
import {
  schedulePostTurnMemoryUpdate,
  type TurnExecutorDeps,
} from "@covel/runtime";
import {
  DEFAULT_LOCALE,
  type RuntimeManifest,
  type RuntimeResult,
} from "@covel/shared";
import type { SessionRecord } from "@covel/store";

/** Resume owns its commit separately, but shares normal post-commit extraction. */
export async function refreshResumedMemory(
  session: SessionRecord,
  result: RuntimeResult,
  manifest: RuntimeManifest,
  deps: TurnExecutorDeps,
): Promise<void> {
  if (!deps.memorySystem || !deps.store || manifest.outputKind !== "story")
    return;
  try {
    const coreMemoryBlocks = await deps.memorySystem.manager.loadBlocks(
      session.id,
    );
    const sessionContext = await buildSessionContextSnapshot(
      deps.store,
      session.id,
      {
        locale: session.locale ?? DEFAULT_LOCALE,
        worldId: session.worldId ?? undefined,
        worldDataPluginId: deps.capabilityPluginIds?.worldDataPluginId,
        turnNumber: session.completedPlayerTurns,
        coreMemoryBlocks,
      },
    );
    schedulePostTurnMemoryUpdate({
      input: {
        sessionId: session.id,
        turnId: result.turnId,
        playerMessage: "",
        origin: "resume",
        locale: session.locale ?? DEFAULT_LOCALE,
      },
      turnResult: { runtimeResults: [result] },
      runtimes: [manifest],
      deps,
      coreMemoryBlocks,
      sessionContext,
    });
  } catch (error) {
    console.warn("[resume] post-commit memory preparation failed:", error);
  }
}
