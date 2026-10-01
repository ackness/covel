import {
  buildSessionContextSnapshot,
  type SessionContextSnapshot,
} from "@covel/context";
import type { SessionSummaryRecord } from "@covel/store";
import {
  DEFAULT_LOCALE,
  sessionWorldContextV1,
  type TurnInput,
} from "@covel/shared";
import type { TurnExecutorDeps } from "./turn-executor-types.js";

export async function loadSessionSummaries(args: {
  readonly input: TurnInput;
  readonly deps: TurnExecutorDeps;
}): Promise<readonly SessionSummaryRecord[]> {
  const { input, deps } = args;
  if (!deps.store) return [];
  return [...(await deps.store.listSessionSummaries(input.sessionId))];
}

export async function refreshSessionContextSnapshot(args: {
  readonly input: TurnInput;
  readonly deps: TurnExecutorDeps;
  readonly turnNumber: number;
  readonly sessionSummaries: readonly SessionSummaryRecord[];
}): Promise<SessionContextSnapshot | undefined> {
  const { input, deps, turnNumber, sessionSummaries } = args;
  if (!deps.store) return undefined;

  try {
    const sessionRecord = await deps.store.getSession(input.sessionId);
    const worldContext = await deps.extensionExecution?.run(
      sessionWorldContextV1,
      {},
    );
    if (
      deps.dimensionProviderPluginId &&
      (worldContext?.dimensionProviderPluginId !==
        deps.dimensionProviderPluginId ||
        worldContext.dimensions === undefined)
    )
      throw new Error("Authoritative dimension snapshot unavailable");
    const context = await buildSessionContextSnapshot(
      deps.store,
      input.sessionId,
      {
        locale: input.locale ?? DEFAULT_LOCALE,
        turnNumber,
        worldId: sessionRecord?.worldId ?? undefined,
        worldContext,
        summaries: sessionSummaries,
        playerMessage: input.playerMessage,
      },
    );
    return deps.dimensionContext
      ? { ...context, world: { ...context.world!, ...deps.dimensionContext } }
      : context;
  } catch (err) {
    if (deps.dimensionProviderPluginId) throw err;
    console.warn("[turn-executor] SessionContextSnapshot build failed:", err);
    return undefined;
  }
}
