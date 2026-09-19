import {
  clearSessionToken,
  listSessionCredentials,
} from "../session-credentials.js";
import { ApiError, request } from "./request.js";
import { z } from "zod";
import { ignoreError } from "../../lib/ignore-error.js";

/** Cleanup probes must not indefinitely delay the authoritative deletion result. */
const CLEANUP_TIMEOUT_MS = 3000;
const sessionIdentitySchema = z.object({
  id: z.string().min(1),
  incarnation: z.string().min(1),
});
type Credential = Awaited<ReturnType<typeof listSessionCredentials>>[number];

async function isObsolete(
  { sessionId, token }: Credential,
  signal: AbortSignal,
  incarnation?: string,
): Promise<boolean> {
  let live: unknown;
  try {
    live = await request<unknown>(
      `/api/sessions/${encodeURIComponent(sessionId)}`,
      {
        headers: { "X-Session-Token": token },
        silentErrors: true,
        retry: false,
        signal,
      },
    );
  } catch (error) {
    if (
      error instanceof ApiError &&
      error.status === 404 &&
      error.code === "session_not_found"
    )
      return true;
    throw error;
  }
  if (incarnation === undefined) return false;
  const identity = sessionIdentitySchema.safeParse(live);
  if (!identity.success || identity.data.id !== sessionId)
    throw new Error("Cannot verify created session identity");
  return identity.data.incarnation !== incarnation;
}

/** Verify after persistence so deletion cleanup can see even a late creation. */
export async function verifyCreatedSessionCredential(
  credential: Credential,
  incarnation: string,
): Promise<void> {
  let obsolete: boolean;
  try {
    obsolete = await isObsolete(
      credential,
      AbortSignal.timeout(CLEANUP_TIMEOUT_MS),
      incarnation,
    );
  } catch {
    // POST succeeded and its credential is durable. Uncertainty cannot revoke it.
    ignoreError("verify created session credential")(
      new Error("Could not verify created session identity"),
    );
    return;
  }
  if (!obsolete) return;
  await clearSessionToken(credential.sessionId, credential.token).catch(() => {
    ignoreError("clear obsolete creation credential")(
      new Error("Could not clear obsolete session credential"),
    );
  });
  throw new Error("Created session is no longer current");
}

/**
 * World deletion can partially succeed or lose its response. Collection listings
 * may hide sessions, so only a per-session absence code authorizes local cleanup.
 * Include previous or externally deleted sessions without duplicating world
 * ownership in the credential database.
 */
export async function pruneMissingSessionCredentials(): Promise<void> {
  const credentials = await listSessionCredentials().catch(() => {
    throw new Error("Could not read session credentials for cleanup");
  });
  if (credentials.length === 0) return;
  const signal = AbortSignal.timeout(CLEANUP_TIMEOUT_MS);
  const outcomes = await Promise.allSettled(
    credentials.map(async ({ sessionId, token }) => {
      if (await isObsolete({ sessionId, token }, signal)) {
        await clearSessionToken(sessionId, token);
      }
    }),
  );
  const failures = outcomes.filter((outcome) => outcome.status === "rejected");
  if (failures.length > 0) {
    // Do not expose response bodies, session identities or credentials in logs.
    throw new Error(
      `Could not verify or clean ${failures.length} session credentials`,
    );
  }
}
