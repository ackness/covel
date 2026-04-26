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
import { collectMediaRefIds, isEnvTruthy, readEnvString } from '@covel/shared';
import type { MediaRef } from '@covel/shared';
import type { DataStore, MediaLifecyclePolicy, MediaStore } from '@covel/store';
import {
  getMediaTokenSecret,
  verifyMediaToken,
} from '../../middleware/media-token.js';
import { singleFlight } from '../../middleware/rate-limit.js';

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

type ErrorCode =
  | 'invalid_request'
  | 'invalid_token'
  | 'forbidden'
  | 'not_found'
  | 'internal'
  | 'unavailable'
  | 'limit_exceeded';

type ErrorStatus = 400 | 401 | 403 | 404 | 500 | 503;

function jsonError(
  code: ErrorCode,
  message: string,
  status: ErrorStatus,
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
  readonly scanLimit?: unknown;
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

function optionalPositiveInteger(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    throw new Error('expected positive integer');
  }
  return value;
}

/**
 * Default per-session row scan ceiling. Each row in {messages, plugin-data,
 * runtime-outputs, trace-events, snapshots, turn-results, runtime-results}
 * contributes; once the running total exceeds this, the route refuses to
 * silently truncate (which would risk deleting still-referenced media) and
 * surfaces a 400 limit_exceeded so the operator can either narrow the scope
 * or pass an explicit larger `scanLimit`.
 */
const DEFAULT_SCAN_LIMIT_PER_SESSION = 1_000;

/** Maximum sessions per kernel batch when iterating large installs. */
const SESSION_BATCH_SIZE = 50;

/** Threshold above which we batch + log progress. */
const LARGE_SESSION_INSTALL = 100;

interface BuildProtectedOptions {
  readonly maxScanRowsPerSession?: number;
  readonly maxSessions?: number;
}

interface BuildProtectedResult {
  readonly protectedIds: Set<string>;
  readonly scannedSessions: number;
  readonly limitExceeded: boolean;
  readonly limitExceededSessionId?: string;
  readonly limitExceededRowCount?: number;
}

export async function buildProtectedMediaIds(
  store: DataStore,
  mediaStore: MediaStore,
  options: BuildProtectedOptions = {},
): Promise<BuildProtectedResult> {
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

  const maxRowsPerSession = options.maxScanRowsPerSession ?? DEFAULT_SCAN_LIMIT_PER_SESSION;
  const sessionsToScan = options.maxSessions !== undefined
    ? sessions.slice(0, options.maxSessions)
    : sessions;
  const totalSessions = sessionsToScan.length;
  const shouldBatch = totalSessions > LARGE_SESSION_INSTALL;

  let scannedSessions = 0;
  for (let batchStart = 0; batchStart < totalSessions; batchStart += SESSION_BATCH_SIZE) {
    const batch = sessionsToScan.slice(batchStart, batchStart + SESSION_BATCH_SIZE);
    for (const session of batch) {
      let rowsForSession = 0;
      const enforceLimit = (rows: { readonly length: number }): boolean => {
        rowsForSession += rows.length;
        return rowsForSession > maxRowsPerSession;
      };

      const messages = await store.listMessages(session.id);
      if (enforceLimit(messages)) {
        return {
          protectedIds,
          scannedSessions,
          limitExceeded: true,
          limitExceededSessionId: session.id,
          limitExceededRowCount: rowsForSession,
        };
      }
      scan(messages);

      const pluginData = await store.listPluginDataSessionScope(session.id);
      if (enforceLimit(pluginData)) {
        return {
          protectedIds,
          scannedSessions,
          limitExceeded: true,
          limitExceededSessionId: session.id,
          limitExceededRowCount: rowsForSession,
        };
      }
      scan(pluginData);

      const runtimeOutputs = await store.listRuntimeOutputs(session.id);
      if (enforceLimit(runtimeOutputs)) {
        return {
          protectedIds,
          scannedSessions,
          limitExceeded: true,
          limitExceededSessionId: session.id,
          limitExceededRowCount: rowsForSession,
        };
      }
      scan(runtimeOutputs);

      const traceEvents = await store.listTraceEvents(session.id);
      if (enforceLimit(traceEvents)) {
        return {
          protectedIds,
          scannedSessions,
          limitExceeded: true,
          limitExceededSessionId: session.id,
          limitExceededRowCount: rowsForSession,
        };
      }
      scan(traceEvents);

      const snapshots = await store.listSnapshots(session.id);
      if (enforceLimit(snapshots)) {
        return {
          protectedIds,
          scannedSessions,
          limitExceeded: true,
          limitExceededSessionId: session.id,
          limitExceededRowCount: rowsForSession,
        };
      }
      scan(snapshots);

      const turnResults = await store.listTurnResults(session.id);
      if (enforceLimit(turnResults)) {
        return {
          protectedIds,
          scannedSessions,
          limitExceeded: true,
          limitExceededSessionId: session.id,
          limitExceededRowCount: rowsForSession,
        };
      }
      scan(turnResults);

      for (const turn of turnResults) {
        const runtimeResults = await store.listRuntimeResults(session.id, turn.turnId);
        if (enforceLimit(runtimeResults)) {
          return {
            protectedIds,
            scannedSessions,
            limitExceeded: true,
            limitExceededSessionId: session.id,
            limitExceededRowCount: rowsForSession,
          };
        }
        scan(runtimeResults);
      }

      scannedSessions += 1;
    }

    if (shouldBatch) {
      // Coarse progress signal for large installs. Stays at console.info so
      // it surfaces in pino's structured stream without triggering the
      // production no-console-log rule (this is operational telemetry, not
      // ad-hoc debugging).
      console.info(`[cleanup] scanned ${scannedSessions}/${totalSessions} sessions`);
    }
  }

  return {
    protectedIds,
    scannedSessions,
    limitExceeded: false,
  };
}

/**
 * `POST /api/media/cleanup` — destructive maintenance endpoint.
 *
 * Hardening summary (audit P1/P2):
 *
 *   1. Disabled by default: must set `COVEL_MEDIA_CLEANUP_ENABLED=true`.
 *   2. Forbidden in `DEPLOYMENT_TIER=commercial` until an admin auth
 *      middleware is wired (no caller-identifying claim available right now,
 *      so we refuse to even inspect the body).
 *   3. `dryRun:false` requires an explicit `X-Confirm-Cleanup: yes` header
 *      so an automated job or curl typo cannot delete bytes.
 *   4. Single-flight wrapper prevents two cleanup runs from racing each
 *      other (the protected-id scan is expensive; concurrent runs would
 *      double the load and risk inconsistent inventories).
 *   5. Per-session row-scan cap (`scanLimit`, default 1_000) refuses to
 *      silently truncate. Operators may raise it explicitly, but the
 *      route never quietly skips rows — that would risk deleting still-
 *      referenced media.
 */
mediaRoutes.post('/cleanup', singleFlight(), async (c) => {
  // Deployment-tier gate first: refuse to even inspect the body in
  // commercial deployments. There is no admin auth wired yet, and a
  // 503 makes that disabled-by-policy state explicit to callers.
  const deploymentTier = readEnvString('DEPLOYMENT_TIER', 'self')?.toLowerCase();
  if (deploymentTier === 'commercial') {
    return jsonError(
      'unavailable',
      'cleanup endpoint not available in this deployment tier',
      503,
    );
  }

  if (!isEnvTruthy('COVEL_MEDIA_CLEANUP_ENABLED')) {
    return jsonError('forbidden', 'cleanup endpoint disabled', 403);
  }

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
  let scanLimit: number;
  try {
    const dryRun = optionalBoolean(body.dryRun) ?? true;
    policy = {
      dryRun,
      ...(body.maxAgeMs === undefined ? {} : { maxAgeMs: optionalNonNegativeNumber(body.maxAgeMs) }),
      ...(body.maxBytes === undefined ? {} : { maxBytes: optionalNonNegativeNumber(body.maxBytes) }),
      ...(body.keepRecentBytes === undefined ? {} : { keepRecentBytes: optionalNonNegativeNumber(body.keepRecentBytes) }),
    };
    scanLimit = optionalPositiveInteger(body.scanLimit) ?? DEFAULT_SCAN_LIMIT_PER_SESSION;
  } catch {
    return jsonError(
      'invalid_request',
      'cleanup policy values must be boolean / non-negative numbers / positive integer for scanLimit',
      400,
    );
  }

  // Destructive runs require an explicit out-of-band confirmation so a
  // misconfigured automation job or accidental curl cannot delete bytes.
  if (policy.dryRun === false) {
    const confirm = c.req.header('x-confirm-cleanup');
    if (confirm !== 'yes') {
      return jsonError(
        'invalid_request',
        'confirmation header missing: set X-Confirm-Cleanup: yes for destructive runs',
        400,
      );
    }
  }

  try {
    const scan = await buildProtectedMediaIds(store, mediaStore, {
      maxScanRowsPerSession: scanLimit,
    });
    if (scan.limitExceeded) {
      return jsonError(
        'limit_exceeded',
        `scan limit exceeded for session ${scan.limitExceededSessionId ?? '<unknown>'} ` +
          `(>${scanLimit} rows); raise scanLimit or shrink scope`,
        400,
      );
    }
    const result = await mediaStore.cleanup(scan.protectedIds, policy);
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
