import * as api from "@/services/api";
import type { SessionWorkspace } from "@/services/data-service.js";
import type { MutableRef } from "./runtime-refs.js";
import type { SessionDispatch } from "./types.js";

/** Commit setup recovery before publishing its session clock to the UI. */
export async function resolveSetupRuntime(
  runtimeId: string,
  resolution: "retry" | "waive",
  options: {
    workspace: SessionWorkspace;
    sessionIdRef: MutableRef<string | null>;
    sessionGenerationRef: MutableRef<number>;
    dispatch: SessionDispatch;
  },
): Promise<void> {
  const { workspace, sessionIdRef, sessionGenerationRef, dispatch } = options;
  const sessionId = sessionIdRef.current;
  if (!sessionId) return;
  const generation = sessionGenerationRef.current;
  const isCurrent = () =>
    sessionIdRef.current === sessionId &&
    sessionGenerationRef.current === generation;
  const session = await workspace.run(
    sessionId,
    `setup-${resolution}:${crypto.randomUUID()}`,
    async () => {
      const recover =
        resolution === "retry" ? api.retrySetupRuntime : api.waiveSetupRuntime;
      await recover(sessionId, runtimeId);
      return api.getSession(sessionId);
    },
    { isCurrent },
  );
  if (isCurrent()) dispatch({ type: "SET_SESSION", session });
}
