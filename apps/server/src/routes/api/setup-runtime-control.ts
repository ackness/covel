/**
 * Setup-runtime control endpoints (player-driven recovery from a blocked setup):
 *
 *   POST /api/sessions/:id/setup/:runtimeId/retry   — blocked → pending (gen+1)
 *   POST /api/sessions/:id/setup/:runtimeId/waive   — blocked → done (waived)
 *                                                     body: { confirm: true }
 *
 * When a setup runtime exhausts its retry budget it lands on `blocked`, which
 * holds the session in the setup band. These two endpoints are the only way out
 * under player control: retry re-arms it for another run, waive marks it done in
 * a degraded state so the plugin's session gate is satisfied.
 *
 * Both are idempotent (a duplicated request has no extra effect) and reject a
 * non-blocked target with 409. Owner-token auth is inherited from the shared
 * session guard, exactly like every other session-scoped route.
 */

import { Hono } from "hono";
import type { DataStore } from "@covel/store";
import { retrySetup, waiveSetup, type SetupControlResult } from "@covel/shared";
import { errorBody, readJsonBody } from "../../api-error.js";
import { rateLimiter } from "../../middleware/rate-limit.js";
import {
  resolveSessionParam,
  withLockedSessionMutation,
} from "./session/session-guard.js";

type Env = {
  Variables: {
    store: DataStore;
  };
};

export const setupRuntimeControlRoutes = new Hono<Env>();

const WAIVE_WARNING =
  "Setup was skipped by the player after repeated failures; this plugin is running in a degraded state.";

/**
 * Apply a resolved control transition to `session.setupRuntimes[runtimeId]`.
 */
async function applyTransition(args: {
  readonly store: DataStore;
  readonly sessionId: string;
  readonly runtimeId: string;
  readonly session: {
    readonly setupRuntimes: Readonly<
      Record<string, import("@covel/shared").SetupRuntimeState>
    >;
  };
  readonly result: Extract<SetupControlResult, { ok: true }>;
}): Promise<void> {
  const { store, sessionId, runtimeId, session, result } = args;
  if (result.noop) return; // idempotent: nothing to persist
  const now = new Date().toISOString();
  const setupRuntimes = {
    ...session.setupRuntimes,
    [runtimeId]: result.next,
  };
  await store.updateSession(sessionId, {
    setupRuntimes,
    updatedAt: now,
  });
}

setupRuntimeControlRoutes.post(
  "/:id/setup/:runtimeId/retry",
  rateLimiter({ max: 30 }),
  async (c) => {
    const guard = await resolveSessionParam(c);
    if (!guard.ok) return guard.response;
    const store = c.get("store");
    const runtimeId = c.req.param("runtimeId");
    return withLockedSessionMutation({
      c,
      store,
      sessionLock: c.get("sessionLock"),
      sessionId: guard.session.id,
      expectedSession: guard.session,
      allowedStatuses: ["active"],
      mutate: async (live) => {
        const result = retrySetup(live.setupRuntimes[runtimeId]);
        if (!result.ok) return c.json(errorBody(result.reason), 409);
        await applyTransition({
          store,
          sessionId: live.id,
          runtimeId,
          session: live,
          result,
        });
        return c.json({ ok: true, runtimeId, state: result.next });
      },
    });
  },
);

setupRuntimeControlRoutes.post(
  "/:id/setup/:runtimeId/waive",
  rateLimiter({ max: 30 }),
  async (c) => {
    const guard = await resolveSessionParam(c);
    if (!guard.ok) return guard.response;
    const store = c.get("store");
    const runtimeId = c.req.param("runtimeId");
    const parsed = await readJsonBody<{ confirm?: unknown }>(c);
    if (parsed instanceof Response) return parsed;
    if (parsed.body.confirm !== true) {
      return c.json(
        errorBody("waive requires an explicit { confirm: true } body", {
          code: "confirm_required",
        }),
        400,
      );
    }
    return withLockedSessionMutation({
      c,
      store,
      sessionLock: c.get("sessionLock"),
      sessionId: guard.session.id,
      expectedSession: guard.session,
      allowedStatuses: ["active"],
      mutate: async (live) => {
        const result = waiveSetup(
          live.setupRuntimes[runtimeId],
          new Date().toISOString(),
          WAIVE_WARNING,
        );
        if (!result.ok) return c.json(errorBody(result.reason), 409);
        await applyTransition({
          store,
          sessionId: live.id,
          runtimeId,
          session: live,
          result,
        });
        return c.json({ ok: true, runtimeId, state: result.next });
      },
    });
  },
);
