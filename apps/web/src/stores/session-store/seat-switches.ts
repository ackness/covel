import { useCallback, useRef } from "react";
import type { Seat } from "@covel/shared";
import * as api from "@/services/api";
import type { SessionWorkspace } from "@/services/data-service.js";
import type { SessionRuntimeRefs } from "./runtime-refs.js";
import type { SessionDispatch } from "./types.js";
import { invalidateSessionResource } from "./session-resource-reads.js";

/** Writes return all seats, so serialize the whole session in both workspace modes. */
export function useSeatSwitches(
  workspace: SessionWorkspace,
  dispatch: SessionDispatch,
  { sessionIdRef, sessionGenerationRef }: SessionRuntimeRefs,
) {
  const pending = useRef(
    new Map<string, Promise<readonly Seat[] | undefined>>(),
  );
  const hasPendingSeatSwitch = useCallback(
    (sessionId: string) => pending.current.has(sessionId),
    [],
  );
  const settleSeatSwitches = useCallback(
    async (sessionId: string, generation: number) => {
      let seats: readonly Seat[] | undefined;
      while (
        sessionIdRef.current === sessionId &&
        sessionGenerationRef.current === generation
      ) {
        const switching = pending.current.get(sessionId);
        if (!switching) return seats;
        seats = (await switching) ?? seats;
      }
      return undefined;
    },
    [sessionIdRef, sessionGenerationRef],
  );
  const switchSeatCharacter = useCallback(
    async (seatId: string, characterId: string): Promise<void> => {
      const sessionId = sessionIdRef.current;
      if (!sessionId) return;
      const previous = pending.current.get(sessionId);
      const mutate = async () => {
        // Browser-private writes still upload and take back their checkpoint.
        const { seats } = await workspace.run(
          sessionId,
          `seat-switch:${crypto.randomUUID()}`,
          () => api.setSeatCurrentCharacter(sessionId, seatId, characterId),
        );
        // This write remains valid across visits to the same session. Only
        // input continuations belong to a particular visit generation.
        if (sessionIdRef.current === sessionId) {
          invalidateSessionResource(dispatch, ["game-state", sessionId]);
          dispatch({ type: "SET_SESSION_SEATS", seats });
        }
        return seats;
      };
      // Keep authorized writes ordered even if the player leaves and returns;
      // another session has its own queue and never waits for this one.
      const switching = previous ? previous.then(mutate) : mutate();
      const settled: Promise<readonly Seat[] | undefined> = switching
        .catch(() => previous)
        .finally(() => {
          if (pending.current.get(sessionId) === settled)
            pending.current.delete(sessionId);
        });
      pending.current.set(sessionId, settled);
      // A refused final choice retains the last successful seats for input,
      // while the caller still receives the error for its normal UI feedback.
      await switching;
    },
    [workspace, dispatch, sessionIdRef],
  );
  return { hasPendingSeatSwitch, settleSeatSwitches, switchSeatCharacter };
}
