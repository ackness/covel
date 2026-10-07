import type { Context } from "hono";
import type { DataStore, SessionRecord } from "@covel/store";
import { errorBody } from "../../../api-error.js";
import type { SessionLock } from "../../../lib/session-lock.js";
import { withSettledSessionLock } from "../plugin-rpc/settled-request.js";
import {
  checkSessionOwner,
  sessionIncarnationIdentity,
  SESSION_DELETION_PENDING_KEY,
  SESSION_NOT_FOUND_CODE,
} from "./session-guard.js";

/** Revalidate a request's session snapshot while its caller holds the lock. */
export async function readLockedSession(options: {
  readonly c: Context;
  readonly store: DataStore;
  readonly sessionId: string;
  readonly expectedSession: SessionRecord;
  readonly allowedStatuses: "any" | readonly string[];
  readonly allowDeletionPending?: boolean;
}): Promise<SessionRecord | Response> {
  const live = await options.store.getSession(options.sessionId);
  if (!live) {
    return options.c.json(
      errorBody(`Session not found: ${options.sessionId}`, {
        code: SESSION_NOT_FOUND_CODE,
      }),
      404,
    );
  }
  const ownerDenied = checkSessionOwner(options.c, live);
  if (ownerDenied) return ownerDenied;
  if (
    sessionIncarnationIdentity(live) !==
    sessionIncarnationIdentity(options.expectedSession)
  ) {
    return options.c.json(
      errorBody("Session was replaced while the request was waiting", {
        code: "session_incarnation_changed",
      }),
      409,
    );
  }
  if (
    !options.allowDeletionPending &&
    live.metadata?.[SESSION_DELETION_PENDING_KEY]
  ) {
    return options.c.json(
      errorBody("Session deletion is in progress; retry DELETE", {
        code: "session_deleting",
      }),
      409,
    );
  }
  if (
    options.allowedStatuses !== "any" &&
    !options.allowedStatuses.includes(live.status)
  ) {
    return options.c.json(
      errorBody(`Session is ${live.status}; mutation refused`, {
        code: "session_not_active",
      }),
      409,
    );
  }
  return live;
}

/**
 * Short commit barrier for session-scoped mutations.
 *
 * Callers parse/validate bodies and perform non-mutating expensive work before
 * entering. The callback runs under the cross-Pod session lock only after the
 * owner, immutable incarnation, deletion marker and explicit status policy are
 * revalidated against the live row.
 */
export async function withLockedSessionMutation<T>(options: {
  readonly c: Context;
  readonly store: DataStore;
  readonly sessionLock: SessionLock;
  readonly sessionId: string;
  readonly expectedSession: SessionRecord;
  readonly allowedStatuses: "any" | readonly string[];
  readonly allowDeletionPending?: boolean;
  readonly mutate: (session: SessionRecord) => Promise<T>;
}): Promise<T | Response> {
  return withSettledSessionLock(options.c, options.sessionId, async () => {
    const live = await readLockedSession(options);
    if (live instanceof Response) return live;
    return options.mutate(live);
  });
}
