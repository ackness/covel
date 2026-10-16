/**
 * Player turn-control endpoints:
 *
 *   POST /api/sessions/:id/steer  { message }  — interject into the active turn
 *   POST /api/sessions/:id/abort                — abort the active turn
 *
 * Both 409 when the session has no in-flight turn; abort is then a no-op.
 * Steer also 409s once the turn can no longer read an interjection (code
 * `steering_closed`): every story runtime of the execution has finished and
 * only bookkeeping is left. On either 409 the client restores the message to
 * the composer for the player to send as a normal message. An accepted
 * interjection is saved with its turn: the turn's commit writes it to the
 * prompt history and the chat log, and a turn that does not commit keeps
 * neither.
 */

import { Hono } from "hono";
import type { DataStore } from "@covel/store";
import { errorBody } from "../../api-error.js";
import { rateLimiter } from "../../middleware/rate-limit.js";
import {
  abortActiveTurn,
  steerActiveTurn,
  type SteerRefusal,
} from "./turn-control.js";
import { resolveSessionById } from "./session/session-guard.js";
import { getSessionExecutionStatus } from "./actions/execution-recovery.js";

type Env = {
  Variables: {
    store: DataStore;
  };
};

const STEER_REFUSAL_MESSAGES: Record<SteerRefusal, string> = {
  no_active_turn: "No active turn to steer",
  steering_closed: "The active turn no longer takes interjections",
};

export const turnControlRoutes = new Hono<Env>();

turnControlRoutes.get("/:id/execution", async (c) => {
  const sessionId = c.req.param("id");
  const store = c.get("store");
  const guard = await resolveSessionById(c, sessionId);
  if (!guard.ok) return guard.response;
  return c.json(
    await getSessionExecutionStatus(store, sessionId, c.get("sessionLock")),
  );
});

turnControlRoutes.post("/:id/steer", rateLimiter({ max: 30 }), async (c) => {
  const sessionId = c.req.param("id");
  const body = await c.req
    .json<{ message?: unknown }>()
    .catch(() => null as { message?: unknown } | null);
  const message = typeof body?.message === "string" ? body.message.trim() : "";
  if (!message) {
    return c.json(errorBody("message (non-empty string) is required"), 400);
  }
  const guard = await resolveSessionById(c, sessionId);
  if (!guard.ok) return guard.response;

  const steered = steerActiveTurn(sessionId, message);
  if ("refused" in steered) {
    // The code tells the client the text was not taken, so it keeps the text
    // for the player instead of showing it as sent.
    return c.json(
      errorBody(STEER_REFUSAL_MESSAGES[steered.refused], {
        code: steered.refused,
      }),
      409,
    );
  }

  return c.json({ ok: true, turnId: steered.turnId });
});

turnControlRoutes.post("/:id/abort", rateLimiter({ max: 30 }), async (c) => {
  const sessionId = c.req.param("id");
  const guard = await resolveSessionById(c, sessionId);
  if (!guard.ok) return guard.response;

  const aborted = abortActiveTurn(sessionId);
  if (!aborted) {
    return c.json(errorBody("No active turn to abort"), 409);
  }
  return c.json({ ok: true, turnId: aborted.turnId });
});
