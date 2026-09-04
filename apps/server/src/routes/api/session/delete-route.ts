import { randomUUID } from "node:crypto";
import type { Hono } from "hono";
import { errorBody, okBody } from "../../../api-error.js";
import {
  SESSION_DELETION_LEASE_MS,
  backgroundLocksForSession,
  fireSessionEnd,
  lifecycleLeaseIsFresh,
  readSessionLifecyclePending,
  withoutDeletionControl,
  withoutLifecyclePending,
} from "./lifecycle.js";
import type { SessionRouteEnv } from "./route-env.js";
import {
  resolveSessionParam,
  rotateSessionApprovalScope,
  sessionIncarnationIdentity,
  SESSION_DELETION_END_FIRED_KEY,
  SESSION_DELETION_PENDING_KEY,
  SESSION_DELETION_RETRY_KEY,
  SESSION_DELETION_STARTED_AT_KEY,
} from "./session-guard.js";

export function registerSessionDeleteRoute(
  routes: Hono<SessionRouteEnv>,
): void {
  routes.delete("/:id", async (c) => {
    const store = c.get("store");
    const id = c.req.param("id");
    const guard = await resolveSessionParam(c);
    if (!guard.ok) return guard.response;
    const expectedIncarnation = sessionIncarnationIdentity(guard.session);
    const sessionLock = c.get("sessionLock");
    const pluginRegistry = c.get("pluginRegistry");
    const clearProcessLocalState = (): void => {
      pluginRegistry.clearSession(id);
      c.get("rpcApprovalGate")?.revoke(id);
      c.get("clearSessionToolOverrides")?.(id);
    };

    const prepared = await sessionLock.withLock(id, async () => {
      const lockedGuard = await resolveSessionParam(c);
      if (!lockedGuard.ok) return lockedGuard.response;
      const session = lockedGuard.session;
      if (sessionIncarnationIdentity(session) !== expectedIncarnation) {
        return c.json(
          errorBody("Session was replaced while DELETE was waiting", {
            code: "session_incarnation_changed",
          }),
          409,
        );
      }
      const existingDeletionNonce =
        session.metadata?.[SESSION_DELETION_PENDING_KEY];
      const deletionStartedAt =
        typeof session.metadata?.[SESSION_DELETION_STARTED_AT_KEY] === "string"
          ? Date.parse(session.metadata[SESSION_DELETION_STARTED_AT_KEY])
          : Number.NaN;
      const staleDeletionLease =
        Number.isFinite(deletionStartedAt) &&
        Date.now() - deletionStartedAt > SESSION_DELETION_LEASE_MS;
      const retryableDeletion =
        typeof existingDeletionNonce === "string" &&
        (session.metadata?.[SESSION_DELETION_RETRY_KEY] ===
          existingDeletionNonce ||
          staleDeletionLease);
      if (existingDeletionNonce && !retryableDeletion) {
        return c.json(
          errorBody("Session deletion is already in progress", {
            code: "session_deleting",
          }),
          409,
        );
      }
      const lifecyclePending = readSessionLifecyclePending(session);
      if (lifecyclePending && lifecycleLeaseIsFresh(lifecyclePending)) {
        return c.json(
          errorBody(
            `Session lifecycle hook ${lifecyclePending.event} is still running`,
            { code: "session_lifecycle_busy" },
          ),
          409,
        );
      }
      const runtimeLockIds = await backgroundLocksForSession(id, store);
      const deletionNonce = randomUUID();
      const skipEndHook =
        retryableDeletion &&
        session.metadata?.[SESSION_DELETION_END_FIRED_KEY] ===
          existingDeletionNonce;
      const approvalSession = {
        ...session,
        metadata: withoutDeletionControl(
          lifecyclePending
            ? withoutLifecyclePending(session.metadata)
            : session.metadata,
        ),
      };
      await store.updateSession(id, {
        ...(session.status !== "ended" ? { status: "paused" as const } : {}),
        metadata: {
          ...rotateSessionApprovalScope(approvalSession),
          [SESSION_DELETION_PENDING_KEY]: deletionNonce,
          [SESSION_DELETION_STARTED_AT_KEY]: new Date().toISOString(),
          ...(skipEndHook
            ? { [SESSION_DELETION_END_FIRED_KEY]: deletionNonce }
            : {}),
        },
        updatedAt: new Date().toISOString(),
      });
      return { session, runtimeLockIds, deletionNonce, skipEndHook };
    });
    if (prepared instanceof Response) return prepared;

    const markDeletionRetryable = async (): Promise<void> => {
      try {
        await sessionLock.withLock(id, async () => {
          const live = await store.getSession(id);
          if (
            !live ||
            sessionIncarnationIdentity(live) !== expectedIncarnation ||
            live.metadata?.[SESSION_DELETION_PENDING_KEY] !==
              prepared.deletionNonce
          ) {
            return;
          }
          await store.updateSession(id, {
            status: "paused",
            metadata: {
              ...live.metadata,
              [SESSION_DELETION_RETRY_KEY]: prepared.deletionNonce,
            },
            updatedAt: new Date().toISOString(),
          });
        });
      } catch (error) {
        console.warn(
          "[sessions] failed to mark DELETE retryable:",
          error instanceof Error ? error.message : String(error),
        );
      }
    };

    const completeDeletion = async (): Promise<Response> => {
      const draining = await sessionLock.withLocks(
        prepared.runtimeLockIds,
        () =>
          sessionLock.withLock(id, async () => {
            const lockedGuard = await resolveSessionParam(c);
            if (!lockedGuard.ok) return lockedGuard.response;
            const session = lockedGuard.session;
            if (sessionIncarnationIdentity(session) !== expectedIncarnation) {
              return c.json(
                errorBody("Session was replaced while DELETE was draining", {
                  code: "session_incarnation_changed",
                }),
                409,
              );
            }
            if (
              session.metadata?.[SESSION_DELETION_PENDING_KEY] !==
              prepared.deletionNonce
            ) {
              return c.json(
                errorBody("Session deletion generation changed", {
                  code: "session_deleting",
                }),
                409,
              );
            }
            return session;
          }),
      );
      if (draining instanceof Response) return draining;

      if (prepared.session.status !== "ended" && !prepared.skipEndHook) {
        await fireSessionEnd(
          c.get("hookPipeline"),
          c.get("eventBus"),
          id,
          prepared.session.activePlugins,
          "deleted",
        );
      }

      return sessionLock.withLock(id, async () => {
        const lockedGuard = await resolveSessionParam(c);
        if (!lockedGuard.ok) return lockedGuard.response;
        const session = lockedGuard.session;
        if (
          sessionIncarnationIdentity(session) !== expectedIncarnation ||
          session.metadata?.[SESSION_DELETION_PENDING_KEY] !==
            prepared.deletionNonce
        ) {
          return c.json(
            errorBody("Session changed before DELETE commit", {
              code: "session_incarnation_changed",
            }),
            409,
          );
        }

        if (
          prepared.session.status !== "ended" &&
          session.metadata?.[SESSION_DELETION_END_FIRED_KEY] !==
            prepared.deletionNonce
        ) {
          await store.updateSession(id, {
            metadata: {
              ...session.metadata,
              [SESSION_DELETION_END_FIRED_KEY]: prepared.deletionNonce,
            },
            updatedAt: new Date().toISOString(),
          });
        }

        try {
          await c.get("mediaStore")?.releaseSession(id);
          await store.deleteSession(id);
        } catch (error) {
          const live = await store.getSession(id);
          if (!live) {
            clearProcessLocalState();
            return c.json(okBody());
          }
          if (
            sessionIncarnationIdentity(live) === expectedIncarnation &&
            live.metadata?.[SESSION_DELETION_PENDING_KEY] ===
              prepared.deletionNonce
          ) {
            try {
              await store.updateSession(id, {
                status: "paused",
                metadata: {
                  ...live.metadata,
                  [SESSION_DELETION_RETRY_KEY]: prepared.deletionNonce,
                },
                updatedAt: new Date().toISOString(),
              });
            } catch (recoveryError) {
              console.warn(
                "[sessions] failed to preserve deletion marker after DELETE error:",
                recoveryError instanceof Error
                  ? recoveryError.message
                  : String(recoveryError),
              );
            }
          }
          throw error;
        }

        clearProcessLocalState();
        return c.json(okBody());
      });
    };

    try {
      return await completeDeletion();
    } catch (error) {
      await markDeletionRetryable();
      throw error;
    }
  });
}
