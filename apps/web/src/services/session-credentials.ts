/**
 * Per-session owner-token store (audit H-01).
 *
 * `POST /api/sessions` mints an owner token and returns it exactly once. On
 * hosted tiers (demo/commercial) the server requires it on every session-scoped
 * call (`X-Session-Token` / `Authorization: Bearer` / `?session_token=`); on
 * self/desktop/dev it is ignored. So we persist it keyed by sessionId and replay
 * it unconditionally — a stray token on a self tier is harmless, and one code
 * path beats branching on the deployment tier the client can't reliably know.
 *
 * localStorage-backed as a single JSON map, written atomically (read → spread →
 * write) so concurrent create/delete never leave a half-written key.
 */

const STORAGE_KEY = "covel:session-tokens";

function readMap(): Record<string, string> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    // Guard against corrupt/legacy shapes — never trust persisted JSON.
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, string>)
      : {};
  } catch {
    // localStorage unavailable (private mode / non-browser test env) or bad
    // JSON — treat as empty; the hosted follow-up will fail visibly, not
    // silently corrupt state.
    return {};
  }
}

function writeMap(map: Record<string, string>): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(map));
  } catch {
    // ponytail: localStorage unavailable — tokens just won't persist across
    // reloads; nothing to recover here.
  }
}

/** Persist the one-time owner token for a session. No-op on empty inputs. */
export function storeSessionToken(sessionId: string, token: string): void {
  if (!sessionId || !token) return;
  writeMap({ ...readMap(), [sessionId]: token });
}

/** The owner token for a session, or undefined if none is stored. */
export function getSessionToken(sessionId: string): string | undefined {
  return readMap()[sessionId];
}

/** Drop a session's token (delete / logout / import). No-op if absent. */
export function clearSessionToken(sessionId: string): void {
  const map = readMap();
  if (!(sessionId in map)) return;
  const { [sessionId]: _removed, ...rest } = map;
  writeMap(rest);
}
