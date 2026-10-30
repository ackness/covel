import * as api from "@/services/api";
import { refreshSessionResource } from "./session-resource-reads.js";
import type { SessionDispatch } from "./types.js";

/**
 * Read the session's action-kind catalogue again. It follows the active
 * plugins, so every path that reloads them calls this too. A read that fails
 * while it is still the current one drops the catalogue, so the composer
 * offers `say` only rather than kinds the plugins no longer provide; the
 * server still validates what is sent.
 */
export function refreshSessionActionKinds(
  dispatch: SessionDispatch,
  sessionId: string,
  isCurrent: () => boolean,
): Promise<void> {
  return refreshSessionResource(dispatch, ["action-kinds", sessionId], {
    isCurrent,
    read: () => api.getSessionActionKinds(sessionId),
    apply: (catalogue) =>
      dispatch({ type: "SET_SESSION_ACTION_KINDS", catalogue }),
  }).catch(() => {
    if (isCurrent())
      dispatch({ type: "SET_SESSION_ACTION_KINDS", catalogue: null });
  });
}
