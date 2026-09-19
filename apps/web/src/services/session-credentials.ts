/**
 * Per-session owner-token store.
 *
 * `POST /api/sessions` mints an owner token and returns it exactly once. On
 * hosted tiers (demo/commercial) the server requires it on every session-scoped
 * call (`X-Session-Token` / `Authorization: Bearer` / `?session_token=`); on
 * self/desktop/dev it is ignored. So we persist it keyed by sessionId and replay
 * it unconditionally — a stray token on a self tier is harmless, and one code
 * path beats branching on the deployment tier the client can't reliably know.
 *
 * Session tokens live in a dedicated IndexedDB database. Transactions preserve
 * sibling writes and compare captured authority before clearing a credential.
 * Credentials are not display caches and never enter checkpoint exports.
 */

import Dexie, { type Table } from "dexie";
import { z } from "zod";

export const SESSION_CREDENTIAL_DB_NAME = "covel-browser-credentials";
const OPERATOR_STORAGE_KEY = "covel:operator-token";

const credentialSchema = z.object({
  sessionId: z.string().min(1),
  token: z.string().min(1),
});
type SessionCredential = z.infer<typeof credentialSchema>;
let database: Dexie | undefined;

async function sessionTable(): Promise<Table<SessionCredential, string>> {
  if (!database) {
    database = new Dexie(SESSION_CREDENTIAL_DB_NAME);
    database.version(1).stores({ sessions: "sessionId" });
  }
  await database.open();
  return database.table("sessions");
}

function validateCredential(value: unknown): SessionCredential {
  const parsed = credentialSchema.safeParse(value);
  if (!parsed.success) throw new Error("Invalid session credential record");
  return parsed.data;
}

async function readToken(
  table: Table<SessionCredential, string>,
  sessionId: string,
): Promise<string | undefined> {
  const record = await table.get(sessionId);
  return record === undefined ? undefined : validateCredential(record).token;
}

/** Persist the one-time owner token for a session. No-op on empty inputs. */
export async function storeSessionToken(
  sessionId: string,
  token: string,
): Promise<void> {
  if (!sessionId || !token) return;
  const record = validateCredential({ sessionId, token });
  await (await sessionTable()).put(record);
}

/** The owner token for a session, or undefined if none is stored. */
export async function getSessionToken(
  sessionId: string,
): Promise<string | undefined> {
  const table = await sessionTable();
  return sessionId ? readToken(table, sessionId) : undefined;
}

/** Admit a creation response without overwriting another in-flight creation. */
export async function storeCreatedSessionToken(
  sessionId: string,
  token: string,
  capturedToken: string | undefined,
): Promise<void> {
  const record = validateCredential({ sessionId, token });
  const table = await sessionTable();
  await table.db.transaction("rw", table, async () => {
    const current = await readToken(table, sessionId);
    if (current && current !== capturedToken && current !== token) {
      throw new Error("Session credential changed during creation");
    }
    await table.put(record);
  });
}

/** Clear exactly the authority captured by the deleting operation. */
export async function clearSessionToken(
  sessionId: string,
  capturedToken: string | undefined,
): Promise<void> {
  if (!sessionId || !capturedToken) return;
  const table = await sessionTable();
  await table.db.transaction("rw", table, async () => {
    if ((await readToken(table, sessionId)) === capturedToken)
      await table.delete(sessionId);
  });
}

/** Persist the operator credential used for hosted administrative calls. */
export function storeOperatorToken(token: string): void {
  if (!token) return;
  try {
    localStorage.setItem(OPERATOR_STORAGE_KEY, token);
  } catch {
    // Storage can be unavailable in hardened/private browser contexts.
  }
}

export function getOperatorToken(): string | undefined {
  try {
    return localStorage.getItem(OPERATOR_STORAGE_KEY) || undefined;
  } catch {
    return undefined;
  }
}

export function clearOperatorToken(): void {
  try {
    localStorage.removeItem(OPERATOR_STORAGE_KEY);
  } catch {
    // No persisted credential to clear.
  }
}

export async function sessionAuthHeaders(
  sessionId: string | undefined,
): Promise<Record<string, string>> {
  if (!sessionId) return {};
  const token = await getSessionToken(sessionId);
  return token ? { "X-Session-Token": token } : {};
}

export function operatorAuthHeaders(): Record<string, string> {
  const token = getOperatorToken();
  return token ? { Authorization: `Bearer ${token}` } : {};
}
