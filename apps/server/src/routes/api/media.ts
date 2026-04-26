/**
 * `GET /api/media/:id?token=<signed>` — short-lived signed access to MediaStore.
 *
 * SPEC §5.1 (g): MediaRef.id is content-addressable so an unauthenticated
 * GET would let any caller dereference any asset they happened to learn an
 * id for. This route enforces three checks before streaming bytes:
 *
 *   1. The query-string `token` verifies under the active HMAC secret AND
 *      the token's id matches the URL parameter.
 *   2. `MediaStore.lookup(id)` confirms the asset exists.
 *   3. The session in the token (`token.sessionId`) is the asset owner OR
 *      has a row in `media_refs` for this asset.
 *
 * On success the route streams bytes back with a long `immutable`
 * `Cache-Control` (the id is content-addressable, so cached responses
 * can never go stale) and an `ETag` matching the id, so subsequent
 * `If-None-Match` requests short-circuit to `304`.
 *
 * The route NEVER leaks stack traces or internal paths; all error
 * branches return JSON `{ error, code }` with HTTP-appropriate status
 * codes. The bootstrap-level `app.onError` already strips error
 * messages in production but we double-up here so a thrown `Error`
 * inside the route never surfaces uncaught.
 */

import { Hono } from 'hono';
import { collectMediaRefIds } from '@covel/shared';
import type { MediaRef } from '@covel/shared';
import type { DataStore, MediaLifecyclePolicy, MediaStore } from '@covel/store';
import {
  getMediaTokenSecret,
  verifyMediaToken,
} from '../../middleware/media-token.js';

/**
 * Module augmentation so `c.get('mediaStore')` / `c.set('mediaStore', ...)`
 * type-check across the server. The field is optional during the P0-a
 * runtime-wiring window so a misconfigured deployment surfaces as 503
 * here rather than a hard 500 in route-loading code.
 */
declare module 'hono' {
  interface ContextVariableMap {
    store: DataStore;
    mediaStore?: MediaStore;
  }
}

export const mediaRoutes = new Hono();

/**
 * Threshold below which we read the entire asset into memory before
 * responding (faster path for tiny thumbnails / icons). Anything larger
 * MUST stream via `openReadStream` to avoid V8 ArrayBuffer pressure.
 *
 * 1 MiB matches the SPEC requirement and aligns with the LLM replay
 * cache's per-entry budget.
 */
const STREAM_THRESHOLD_BYTES = 1 * 1024 * 1024;

interface ErrorBody {
  readonly error: string;
  readonly code: string;
}

function jsonError(
  code: 'invalid_request' | 'invalid_token' | 'forbidden' | 'not_found' | 'internal' | 'unavailable',
  message: string,
  status: 400 | 401 | 403 | 404 | 500 | 503,
): Response {
  const body: ErrorBody = { error: message, code };
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

interface CleanupRequestBody {
  readonly dryRun?: unknown;
  readonly maxBytes?: unknown;
  readonly maxAgeMs?: unknown;
  readonly keepRecentBytes?: unknown;
}

function optionalBoolean(value: unknown): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'boolean') {
    throw new Error('expected boolean');
  }
  return value;
}

function optionalNonNegativeNumber(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new Error('expected non-negative number');
  }
  return value;
}

async function buildProtectedMediaIds(
  store: DataStore,
  mediaStore: MediaStore,
): Promise<Set<string>> {
  const protectedIds = new Set<string>();
  const sessions = await store.listSessions();
  const liveSessionIds = new Set(sessions.map((session) => session.id));

  for (const asset of await mediaStore.listAssets()) {
    if (asset.ownerSessionId && liveSessionIds.has(asset.ownerSessionId)) {
      protectedIds.add(asset.id);
    }
  }
  for (const ref of await mediaStore.listRefs()) {
    if (liveSessionIds.has(ref.sessionId)) {
      protectedIds.add(ref.mediaId);
    }
  }

  const scan = (value: unknown): void => {
    for (const id of collectMediaRefIds(value)) protectedIds.add(id);
  };

  for (const session of sessions) {
    scan(await store.listMessages(session.id));
    scan(await store.listPluginDataSessionScope(session.id));
    scan(await store.listRuntimeOutputs(session.id));
    scan(await store.listTraceEvents(session.id));
    scan(await store.listSnapshots(session.id));

    const turnResults = await store.listTurnResults(session.id);
    scan(turnResults);
    for (const turn of turnResults) {
      scan(await store.listRuntimeResults(session.id, turn.turnId));
    }
  }

  return protectedIds;
}

mediaRoutes.post('/cleanup', async (c) => {
  const store = c.get('store');
  const mediaStore = c.get('mediaStore');
  if (!mediaStore) {
    return jsonError('unavailable', 'media store not configured', 503);
  }

  let body: CleanupRequestBody = {};
  try {
    const parsed = await c.req.json().catch(() => ({}));
    if (parsed && typeof parsed === 'object') body = parsed as CleanupRequestBody;
  } catch {
    return jsonError('invalid_request', 'invalid cleanup request body', 400);
  }

  let policy: MediaLifecyclePolicy;
  try {
    const dryRun = optionalBoolean(body.dryRun) ?? true;
    policy = {
      dryRun,
      ...(body.maxAgeMs === undefined ? {} : { maxAgeMs: optionalNonNegativeNumber(body.maxAgeMs) }),
      ...(body.maxBytes === undefined ? {} : { maxBytes: optionalNonNegativeNumber(body.maxBytes) }),
      ...(body.keepRecentBytes === undefined ? {} : { keepRecentBytes: optionalNonNegativeNumber(body.keepRecentBytes) }),
    };
  } catch {
    return jsonError('invalid_request', 'cleanup policy values must be boolean or non-negative numbers', 400);
  }

  try {
    const protectedIds = await buildProtectedMediaIds(store, mediaStore);
    const result = await mediaStore.cleanup(protectedIds, policy);
    return new Response(JSON.stringify({ policy, result }), {
      status: 200,
      headers: { 'content-type': 'application/json; charset=utf-8' },
    });
  } catch {
    return jsonError('internal', 'media cleanup failed', 500);
  }
});

mediaRoutes.get('/:id', async (c) => {
  const id = c.req.param('id');
  const token = c.req.query('token');

  if (!id || typeof id !== 'string' || id.length === 0) {
    return jsonError('invalid_request', 'media id is required', 400);
  }
  if (!token || typeof token !== 'string') {
    return jsonError('invalid_request', 'token query parameter is required', 400);
  }

  // Resolve the secret lazily so the dev-mode warning fires only when the
  // route is actually hit, not at import time.
  let secret: string;
  try {
    secret = getMediaTokenSecret();
  } catch {
    // Production missing-secret path. Don't leak the underlying message.
    return jsonError('internal', 'media token signing is not configured', 500);
  }

  const verdict = verifyMediaToken(token, id, secret);
  if (!verdict.ok) {
    return jsonError('invalid_token', `token ${verdict.reason}`, 401);
  }

  const store = c.get('mediaStore');
  if (!store) {
    // P0-a transitional: Codex A hasn't wired the real MediaStore yet.
    return jsonError('unavailable', 'media store not configured', 503);
  }

  // Asset existence + ownership check.
  let lookup: Awaited<ReturnType<MediaStore['lookup']>>;
  try {
    lookup = await store.lookup(id);
  } catch {
    return jsonError('internal', 'media lookup failed', 500);
  }
  if (!lookup) {
    return jsonError('not_found', 'media not found', 404);
  }

  let allowed = lookup.ownerSessionId === verdict.sessionId;
  if (!allowed) {
    try {
      allowed = await store.isReferencedBy(id, verdict.sessionId);
    } catch {
      return jsonError('internal', 'media reference check failed', 500);
    }
  }
  if (!allowed) {
    return jsonError('forbidden', 'session does not reference this media', 403);
  }

  // ETag short-circuit. id is the SHA-256 of the bytes, so any cached
  // response is permanently fresh.
  const etag = `"${id}"`;
  const ifNoneMatch = c.req.header('if-none-match');
  if (ifNoneMatch && ifNoneMatch === etag) {
    return new Response(null, {
      status: 304,
      headers: {
        etag,
        'cache-control': 'private, max-age=300, immutable',
      },
    });
  }

  const ref: MediaRef = { id, mime: lookup.mime, size: lookup.size };

  // Streaming path for >1 MiB assets, eager Buffer for the rest.
  const baseHeaders: Record<string, string> = {
    'content-type': lookup.mime,
    'content-length': String(lookup.size),
    etag,
    'cache-control': 'private, max-age=300, immutable',
    // Asset is opaque content; instruct browsers not to sniff alternate types.
    'x-content-type-options': 'nosniff',
  };

  try {
    if (lookup.size > STREAM_THRESHOLD_BYTES && typeof store.openReadStream === 'function') {
      const stream = await store.openReadStream(ref);
      return new Response(stream, { status: 200, headers: baseHeaders });
    }

    const bytes = await store.get(ref);
    // Normalise to a fresh ArrayBuffer-backed view. `Response` body init
    // requires `BufferSource | Blob | ...`; Node's `Buffer` (and some
    // SharedArrayBuffer-backed Uint8Arrays) don't satisfy that under
    // strict lib typings, so we copy into a plain ArrayBuffer.
    let body: ArrayBuffer;
    if (bytes instanceof Uint8Array) {
      body = bytes.buffer.slice(
        bytes.byteOffset,
        bytes.byteOffset + bytes.byteLength,
      ) as ArrayBuffer;
    } else {
      body = await (bytes as Blob).arrayBuffer();
    }
    return new Response(body, { status: 200, headers: baseHeaders });
  } catch {
    return jsonError('internal', 'media read failed', 500);
  }
});
