import type { Context } from "hono";
import { errorBody } from "../api-error.js";

const inflight = new Set<string>();

export interface WorldAuthoringFlightHold {
  release(): void;
}

/**
 * Acquire a target-scoped single-flight mark for server-side world authoring.
 *
 * Returns `undefined` when another request already holds `key`. Callers must
 * release the hold when streaming finishes or on any early exit before streaming.
 */
export function acquireWorldAuthoringFlight(
  key: string,
): WorldAuthoringFlightHold | undefined {
  if (inflight.has(key)) return undefined;
  inflight.add(key);
  let released = false;
  return {
    release() {
      if (released) return;
      released = true;
      inflight.delete(key);
    },
  };
}

export function worldAuthoringFlightConflict(c: Context): Response {
  return c.json(
    errorBody("Operation already in progress", {
      code: "operation_in_progress",
    }),
    429,
  );
}
