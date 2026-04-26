import type { MediaRef } from '@covel/shared';
import type { MediaStore } from '@covel/store';
import type { FunctionHandlerContext, PluginRuntimeUtils } from '@covel/plugin-loader';

type MediaContext = NonNullable<FunctionHandlerContext['media']>;
type IngestUrlOptions = Parameters<MediaContext['ingestUrl']>[1];

/**
 * Narrowed view of `MediaStore` that the plugin-facing media context is
 * allowed to call. We deliberately expose the read/write surface plus the
 * authorisation helpers (`lookup` / `isReferencedBy` / `addRef`) so the
 * context can enforce per-session ownership before returning bytes — the
 * same gate `/api/media/:id` runs at the HTTP layer.
 *
 * `put`/`ingestUrl` perform put-time `addRef` (alongside `recordOwnership`)
 * so the owner row is always present and the second-writer in a content-
 * addressed dedup keeps a ref of its own atomically — no commit-time
 * follow-up is required to make the owner discoverable in `media_refs`.
 *
 * `get`/`resolveUrl` reject when the calling session neither owns the asset
 * nor has an explicit ref. `resolveUrl` further refuses to expose the
 * backend-native URL (e.g. `file://…` for SQLite) because that would bypass
 * the HTTP token gate; plugin-facing callers must use the framework's
 * media-token endpoint to obtain a fetchable URL.
 */
export type MediaStoreLike = Pick<
  MediaStore,
  'put' | 'get' | 'resolveUrl' | 'recordOwnership' | 'lookup' | 'isReferencedBy' | 'addRef'
>;

interface CreateRuntimeMediaContextOptions {
  /**
   * Identifies which session writes assets through this context. Required so
   * every `put` / `ingestUrl` call records ownership and the `/api/media/:id`
   * route can authorise dereferencing. Kernel-level callers that genuinely
   * need an owner-less path should use a dedicated helper instead of this
   * runtime context.
   */
  readonly sessionId: string;
  /**
   * Identifies which plugin writes the asset. Optional because the kernel
   * itself may write through the same context without a plugin scope.
   */
  readonly pluginId?: string;
  readonly maxRedirects?: number;
  readonly defaultMaxBytes?: number;
  readonly defaultTimeoutMs?: number;
}

const DEFAULT_MAX_BYTES = 50 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_REDIRECTS = 5;
const REDIRECT_STATUS = new Set([301, 302, 303, 307, 308]);

export function createRuntimeMediaContext(
  mediaStore: MediaStoreLike,
  utils: PluginRuntimeUtils | undefined,
  options: CreateRuntimeMediaContextOptions,
): MediaContext {
  const { sessionId, pluginId } = options;
  return {
    async put(blob, mime, meta) {
      const ref = await mediaStore.put(blob, mime, meta);
      // First-writer-wins inside MediaStore.recordOwnership: a duplicate
      // (same SHA-256) put from a second session reuses the existing row
      // without overwriting the original owner. We always pair it with a
      // put-time addRef so (a) the owner session itself has a ref row
      // (uniform authorisation lookups, simpler fork/cleanup), and
      // (b) the second writer of a deduped asset still gains the
      // explicit reference required by `isReferencedBy()` — without
      // having to wait for an asset.generate proposal to be committed.
      await mediaStore.recordOwnership(ref.id, sessionId, pluginId);
      await mediaStore.addRef(ref.id, sessionId, pluginId);
      return ref;
    },
    async get(ref) {
      await assertReadable(mediaStore, ref.id, sessionId);
      return mediaStore.get(ref);
    },
    async resolveUrl(ref) {
      await assertReadable(mediaStore, ref.id, sessionId);
      // Deliberately do NOT return the backend-native URL: `MediaStore`
      // implementations may hand out `file://…` (SQLite) or other
      // direct-access URLs that bypass the `/api/media/:id?token=…`
      // gate. Plugin code that needs a fetchable URL must mint a
      // session-scoped media token via the framework helper instead;
      // this opaque placeholder makes the indirection explicit so any
      // accidental `<img src={…}>` use surfaces immediately.
      return `media:${ref.id}`;
    },
    async ingestUrl(url, opts) {
      if (!utils) {
        throw new Error('ctx.media.ingestUrl requires runtime utils');
      }
      const ref = await ingestUrlIntoStore(mediaStore, utils, url, opts, options);
      await mediaStore.recordOwnership(ref.id, sessionId, pluginId);
      await mediaStore.addRef(ref.id, sessionId, pluginId);
      return ref;
    },
  };
}

async function assertReadable(
  mediaStore: MediaStoreLike,
  id: string,
  sessionId: string,
): Promise<void> {
  // Cheap path: lookup() returns owner metadata in a single call; if we
  // already own it, skip the second round-trip. Otherwise fall back to
  // isReferencedBy() which also covers fork-style ref rows.
  const lookup = await mediaStore.lookup(id);
  if (lookup === null) {
    throw new Error('media not accessible by this session');
  }
  if (lookup.ownerSessionId === sessionId) return;
  const referenced = await mediaStore.isReferencedBy(id, sessionId);
  if (!referenced) {
    throw new Error('media not accessible by this session');
  }
}

async function ingestUrlIntoStore(
  mediaStore: MediaStoreLike,
  utils: PluginRuntimeUtils,
  url: string,
  opts: IngestUrlOptions | undefined,
  contextOptions: CreateRuntimeMediaContextOptions,
): Promise<MediaRef> {
  const originalUrl = normalizeAndValidateUrl(url, utils);
  const maxBytes = positiveInteger(opts?.maxBytes, contextOptions.defaultMaxBytes ?? DEFAULT_MAX_BYTES);
  const timeoutMs = positiveInteger(opts?.timeoutMs, contextOptions.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS);
  const maxRedirects = contextOptions.maxRedirects ?? DEFAULT_MAX_REDIRECTS;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(new Error('media ingest timed out')), timeoutMs);
  const signal = combineAbortSignals(controller.signal, opts?.signal);

  try {
    const { response, finalUrl } = await fetchWithValidatedRedirects(utils, originalUrl, {
      maxRedirects,
      signal,
    });
    if (!response.ok) {
      throw new Error(`media ingest failed with HTTP ${response.status}`);
    }

    const contentLength = response.headers.get('content-length');
    if (contentLength) {
      const parsedLength = Number(contentLength);
      if (Number.isFinite(parsedLength) && parsedLength > maxBytes) {
        throw new Error(`media ingest exceeds maxBytes (${maxBytes})`);
      }
    }

    const bytes = await readResponseBytes(response, maxBytes, signal);
    const sniffedMime = sniffMime(bytes);
    const headerMime = parseContentType(response.headers.get('content-type'));
    const mime = sniffedMime ?? headerMime ?? 'application/octet-stream';
    if (opts?.allowedMimes && !isMimeAllowed(mime, opts.allowedMimes)) {
      throw new Error(`media ingest MIME ${mime} is outside allowedMimes`);
    }

    return mediaStore.put(bytes, mime, {
      ...opts?.meta,
      originalUrl: originalUrl.toString(),
      finalUrl: finalUrl.toString(),
    });
  } finally {
    clearTimeout(timeout);
  }
}

function normalizeAndValidateUrl(rawUrl: string, utils: PluginRuntimeUtils): URL {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error(`media ingest URL is invalid: ${rawUrl}`);
  }
  const verdict = utils.validateBaseUrl(parsed.toString());
  if (!verdict.ok) {
    throw new Error(`media ingest URL rejected: ${verdict.reason ?? parsed.toString()}`);
  }
  return parsed;
}

async function fetchWithValidatedRedirects(
  utils: PluginRuntimeUtils,
  startUrl: URL,
  opts: {
    readonly maxRedirects: number;
    readonly signal: AbortSignal;
  },
): Promise<{ readonly response: Response; readonly finalUrl: URL }> {
  let currentUrl = startUrl;
  for (let redirectCount = 0; redirectCount <= opts.maxRedirects; redirectCount += 1) {
    const response = await utils.fetchWithRetry(currentUrl, {
      method: 'GET',
      redirect: 'manual',
      maxRetries: 2,
      signal: opts.signal,
    });
    if (!REDIRECT_STATUS.has(response.status)) return { response, finalUrl: currentUrl };

    const location = response.headers.get('location');
    await response.arrayBuffer().catch(() => undefined);
    if (!location) {
      throw new Error(`media ingest redirect ${response.status} is missing Location`);
    }
    currentUrl = normalizeAndValidateUrl(new URL(location, currentUrl).toString(), utils);
  }
  throw new Error(`media ingest exceeded redirect limit (${opts.maxRedirects})`);
}

async function readResponseBytes(
  response: Response,
  maxBytes: number,
  signal: AbortSignal,
): Promise<Uint8Array> {
  if (!response.body) {
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > maxBytes) throw new Error(`media ingest exceeds maxBytes (${maxBytes})`);
    return bytes;
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      if (signal.aborted) throw abortError(signal);
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        throw new Error(`media ingest exceeds maxBytes (${maxBytes})`);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

function sniffMime(bytes: Uint8Array): string | undefined {
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png';
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return 'image/jpeg';
  if (startsWith(bytes, [0x47, 0x49, 0x46, 0x38])) return 'image/gif';
  if (
    bytes.length >= 12 &&
    ascii(bytes.slice(0, 4)) === 'RIFF' &&
    ascii(bytes.slice(8, 12)) === 'WEBP'
  ) return 'image/webp';
  if (startsWith(bytes, [0x25, 0x50, 0x44, 0x46, 0x2d])) return 'application/pdf';
  if (startsWith(bytes, [0x49, 0x44, 0x33])) return 'audio/mpeg';
  if (startsWith(bytes, [0xff, 0xfb]) || startsWith(bytes, [0xff, 0xf3]) || startsWith(bytes, [0xff, 0xf2])) {
    return 'audio/mpeg';
  }
  if (
    bytes.length >= 12 &&
    ascii(bytes.slice(4, 8)) === 'ftyp'
  ) {
    const brand = ascii(bytes.slice(8, 12));
    if (brand.startsWith('M4A')) return 'audio/mp4';
    return 'video/mp4';
  }
  return undefined;
}

function parseContentType(raw: string | null): string | undefined {
  if (!raw) return undefined;
  const mime = raw.split(';', 1)[0]?.trim().toLowerCase();
  if (!mime || !/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/i.test(mime)) return undefined;
  return mime;
}

function isMimeAllowed(mime: string, allowedMimes: readonly string[]): boolean {
  const normalized = mime.toLowerCase();
  return allowedMimes.some((candidate) => {
    const allowed = candidate.toLowerCase();
    if (allowed === normalized) return true;
    if (allowed.endsWith('/*')) return normalized.startsWith(`${allowed.slice(0, -1)}`);
    return false;
  });
}

function startsWith(bytes: Uint8Array, prefix: readonly number[]): boolean {
  if (bytes.length < prefix.length) return false;
  return prefix.every((value, index) => bytes[index] === value);
}

function ascii(bytes: Uint8Array): string {
  return String.fromCharCode(...bytes);
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return Number.isFinite(value) && value! > 0 ? Math.floor(value!) : fallback;
}

function combineAbortSignals(primary: AbortSignal, secondary: AbortSignal | undefined): AbortSignal {
  if (!secondary) return primary;
  if (secondary.aborted) return secondary;
  const controller = new AbortController();
  const abort = (signal: AbortSignal) => {
    if (!controller.signal.aborted) controller.abort(signal.reason);
  };
  primary.addEventListener('abort', () => abort(primary), { once: true });
  secondary.addEventListener('abort', () => abort(secondary), { once: true });
  return controller.signal;
}

function abortError(signal: AbortSignal): Error {
  const reason = signal.reason;
  return reason instanceof Error ? reason : new Error('media ingest aborted');
}
