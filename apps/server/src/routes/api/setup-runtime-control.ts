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
import { resolveSessionParam } from "./session/session-guard.js";

type Env = {
  Variables: {
    store: DataStore;
  };
};

export const setupRuntimeControlRoutes = new Hono<Env>();

const WAIVE_WARNING =
  "Setup was skipped by the player after repeated failures; this plugin is running in a degraded state.";

/**
 * Apply a resolved control transition to `session.setupRuntimes[runtimeId]`. The
 * setup mirror is the sole write surface; the legacy `preGameCompleted` set is
 * derived from it at read time, so a waived runtime enters it (and a retried one
 * leaves it) without a separate column write.
 */
async function applyTransition(args: {
  readonly store: DataStore;
  readonly sessionId: string;
  readonly runtimeId: string;
  readonly session: {
    readonly setupRuntimes?: Readonly<
      Record<string, import("@covel/shared").SetupRuntimeState>
    >;
  };
  readonly result: Extract<SetupControlResult, { ok: true }>;
}): Promise<void> {
  const { store, sessionId, runtimeId, session, result } = args;
  if (result.noop) return; // idempotent: nothing to persist
  const now = new Date().toISOString();
  const setupRuntimes = {
    ...(session.setupRuntimes ?? {}),
    [runtimeId]: result.next,
  };
  // Setup mirror is the sole write surface; `preGameCompleted` derives from it
  // at read time.
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
    const current = guard.session.setupRuntimes?.[runtimeId];
    const result = retrySetup(current);
    if (!result.ok) return c.json(errorBody(result.reason), 409);
    await applyTransition({
      store,
      sessionId: guard.session.id,
      runtimeId,
      session: guard.session,
      result,
    });
    return c.json({ ok: true, runtimeId, state: result.next });
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
    const current = guard.session.setupRuntimes?.[runtimeId];
    const result = waiveSetup(current, new Date().toISOString(), WAIVE_WARNING);
    if (!result.ok) return c.json(errorBody(result.reason), 409);
    await applyTransition({
      store,
      sessionId: guard.session.id,
      runtimeId,
      session: guard.session,
      result,
    });
    return c.json({ ok: true, runtimeId, state: result.next });
  },
);
