/**
 * Session-param resolution guard.
 *
 * 13 session-scoped route files repeated the same pattern:
 *
 *   const session = await store.getSession(id);
 *   if (!session) return c.json({ error: "Session not found" }, 404);
 *
 * with several incompatible 404 bodies (`{error}`, `Session not found: <id>`,
 * `{status,error}`, `{error,code}`). `resolveSessionParam` centralises this so
 * every session-scoped 404 returns the unified envelope:
 *
 *   { "error": "Session not found: <id>", "code": "session_not_found" }
 *
 * Routes call `resolveSessionParam(c)` and branch on the discriminated result.
 */
import type { Context } from "hono";
import type { SessionRecord } from "@covel/store";
import { errorBody } from "../../../api-error.js";

export const SESSION_NOT_FOUND_CODE = "session_not_found";

type ResolveResult =
  | { readonly ok: true; readonly session: SessionRecord }
  | { readonly ok: false; readonly response: Response };

/**
 * Look up the session named by the `:id` route param. On miss, the returned
 * `response` is a ready-to-return 404 with the unified error envelope.
 */
export async function resolveSessionParam(c: Context): Promise<ResolveResult> {
  const store = c.get("store");
  const sessionId = c.req.param("id") ?? "";
  const session = await store.getSession(sessionId);
  if (!session) {
    return {
      ok: false,
      response: c.json(
        errorBody(`Session not found: ${sessionId}`, {
          code: SESSION_NOT_FOUND_CODE,
        }),
        404,
      ),
    };
  }
  return { ok: true, session };
}
