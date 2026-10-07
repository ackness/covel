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
import type { LoadedTurnSessionState } from "./session-state.js";
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
  /**
   * What `loadTurnSessionState` read for this execution. The snapshot is built
   * from these rows instead of re-reading the session, characters and newest
   * form submission. A prompt shows the same form values the runtimes got.
   */
  readonly sessionState?: Pick<
    LoadedTurnSessionState,
    "session" | "sessionMeta" | "recentMessages"
  >;
}): Promise<SessionContextSnapshot | undefined> {
  const { input, deps, turnNumber, sessionSummaries, sessionState } = args;
  if (!deps.store) return undefined;

  try {
    // The session row and the world context do not depend on each other.
    const [sessionRecord, worldContext] = await Promise.all([
      sessionState
        ? sessionState.session
        : deps.store.getSession(input.sessionId),
      deps.extensionExecution?.run(sessionWorldContextV1, {}),
    ]);
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
        recentMessages: sessionState?.recentMessages,
        loaded: {
          session: sessionRecord,
          ...(sessionState
            ? {
                characters: sessionState.sessionMeta.characters,
                lastFormValues: sessionState.sessionMeta.lastFormValues ?? null,
              }
            : {}),
        },
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
