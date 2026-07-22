/**
 * Turn-artifact listing:
 *
 *   GET /api/sessions/:id/turns[?limit=n] — persisted turn_results rows
 *   (execution artifacts with commitStatus / origin), oldest first.
 *
 * Restores the endpoint removed in the dead-route sweep: the audit scanned
 * apps/* for callers but missed scripts/e2e-plugin-verify.ts, which polls
 * this after every action to assert the latest turn's commit outcome. The
 * debug-oriented trace grouping (/api/traces/:sid/turns) has a different
 * shape and reads the fast-growing trace_events table, so it is not a
 * substitute for the harness's cheap artifact poll.
 */

import { Hono } from "hono";
import type { DataStore } from "@covel/store";
import { rateLimiter } from "../../middleware/rate-limit.js";
import { resolveSessionParam } from "./session/session-guard.js";

type Env = {
  Variables: {
    store: DataStore;
  };
};

export const sessionTurnRoutes = new Hono<Env>();

sessionTurnRoutes.get("/:id/turns", rateLimiter({ max: 120 }), async (c) => {
  const resolved = await resolveSessionParam(c);
  if (!resolved.ok) return resolved.response;

  const rawLimit = Number.parseInt(c.req.query("limit") ?? "", 10);
  const limit =
    Number.isFinite(rawLimit) && rawLimit > 0
      ? Math.min(rawLimit, 500)
      : undefined;

  const store = c.get("store");
  const turns = await store.listTurnResults(resolved.session.id, limit);
  return c.json({ turns });
});
