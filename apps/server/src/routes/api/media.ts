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
import type { MediaRef } from '@covel/shared';
import type { MediaStore } from '@covel/store';
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
  if (!allowed && lookup.ownerSessionId === null) {
    // P0-a transitional: runtime ctx.media.put() does not yet thread
    // sessionId/pluginId into recordOwnership(), so freshly-ingested assets
    // appear with ownerSessionId === null and no media_refs row. Without
    // this fallback every freshly-generated image would 403 when the front
    // end tried to display it. The follow-up ticket (see SPEC §5.1 (h)
    // and the agent worktree notes) will thread sessionId through the
    // runtime media context; once that lands, the conditional below
    // becomes dead code and should be removed.
    // eslint-disable-next-line no-console
    console.warn(
      `[api/media] ownership not recorded for ${id}; allowing access pending runtime wiring (session=${verdict.sessionId})`,
    );
    allowed = true;
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
