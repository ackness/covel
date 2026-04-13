/**
 * Dev-mode LLM request record/replay cache.
 *
 * Activated only when COVEL_LLM_REPLAY env var is set. Otherwise every
 * exported function returns immediately as a no-op so production paths
 * are completely untouched.
 *
 * Modes:
 *   record  — always call upstream, overwrite cache on every hit
 *   replay  — read cache only; throw if not present
 *   auto    — replay if cached, otherwise record (default dev workflow)
 *
 * Key derivation: sha256(method + "\n" + url + "\n" + canonicalJson(body)).
 * Headers (notably authorization) are intentionally excluded so the same
 * logical request replays across rotating API keys.
 *
 * Streaming responses are tee'd: the live stream is forwarded to the caller
 * while a duplicate is buffered in memory and written to disk at end-of-stream.
 * If the buffered SSE body exceeds STREAM_BUFFER_LIMIT_BYTES the buffer is
 * dropped (no cache write) so we never balloon memory on long replies.
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

export type ReplayMode = "record" | "replay" | "auto" | "off";

interface CachedRequest {
  readonly method: string;
  readonly url: string;
  readonly body: unknown;
  readonly bodyHash: string;
  readonly recordedAt: string;
}

interface CachedResponseBody {
  readonly status: number;
  readonly statusText: string;
  readonly headers: Record<string, string>;
  /** Set for non-streaming responses. */
  readonly bodyText?: string;
  /** Set for SSE streaming responses (raw concatenated body). */
  readonly sseText?: string;
}

interface CacheEntry {
  readonly request: CachedRequest;
  readonly response: CachedResponseBody;
}

/** Maximum buffered streaming body before we abort caching this request. */
const STREAM_BUFFER_LIMIT_BYTES = 10 * 1024 * 1024;

/** Header keys that are safe to persist (everything else is stripped). */
const SAFE_RESPONSE_HEADERS = new Set(["content-type"]);

/** Sensitive request body keys that get redacted before hashing/saving. */
const REDACT_KEYS = new Set([
  "api_key",
  "apikey",
  "authorization",
  "x-api-key",
  "auth",
  "token",
  "access_token",
]);

const REDACTED = "<REDACTED>";

/** Resolve the active mode from env. Read on every call so tests can flip it. */
export function getReplayMode(): ReplayMode {
  const raw = process.env.COVEL_LLM_REPLAY?.trim().toLowerCase();
  if (raw === "record" || raw === "replay" || raw === "auto") return raw;
  return "off";
}

/** Resolve the cache directory; defaults to debugs/llm-cache under cwd. */
export function getCacheDir(): string {
  const raw = process.env.COVEL_LLM_REPLAY_DIR?.trim();
  return resolve(raw && raw.length > 0 ? raw : "debugs/llm-cache");
}

/**
 * Stable canonical JSON: sorts object keys recursively. Arrays preserve order.
 * This guarantees `{a:1,b:2}` and `{b:2,a:1}` hash to the same bytes.
 */
function canonicalize(value: unknown): unknown {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(canonicalize);
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  const out: Record<string, unknown> = {};
  for (const key of keys) out[key] = canonicalize(obj[key]);
  return out;
}

/** Recursively redact sensitive keys. Non-mutating. */
function redact(value: unknown): unknown {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(redact);
  const obj = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(obj)) {
    if (REDACT_KEYS.has(key.toLowerCase())) {
      out[key] = REDACTED;
    } else {
      out[key] = redact(val);
    }
  }
  return out;
}

/** Compute the stable cache key for a request. */
export function hashRequest(method: string, url: string, body: unknown): string {
  const canonical = canonicalize(redact(body));
  const payload = `${method.toUpperCase()}\n${url}\n${JSON.stringify(canonical)}`;
  return createHash("sha256").update(payload).digest("hex");
}

function entryPath(hash: string): string {
  return join(getCacheDir(), `${hash}.json`);
}

/** Read a cache entry from disk; returns null on miss or any read error. */
export function loadCached(hash: string): CacheEntry | null {
  const file = entryPath(hash);
  if (!existsSync(file)) return null;
  try {
    const raw = readFileSync(file, "utf8");
    return JSON.parse(raw) as CacheEntry;
  } catch (err) {
    console.warn(`[replay-cache] Failed to read ${file}:`, err instanceof Error ? err.message : err);
    return null;
  }
}

/** Write an entry to disk + append a one-line index summary for browsing. */
export function saveCached(hash: string, entry: CacheEntry): void {
  const dir = getCacheDir();
  try {
    mkdirSync(dir, { recursive: true });
    const file = entryPath(hash);
    writeFileSync(file, JSON.stringify(entry, null, 2), "utf8");
    const summary = `${entry.request.recordedAt}\t${hash}\t${entry.response.status}\t${entry.request.url}\n`;
    appendFileSync(join(dir, "index.jsonl"), summary, "utf8");
  } catch (err) {
    console.warn(`[replay-cache] Failed to write ${hash}:`, err instanceof Error ? err.message : err);
  }
}

/** Filter response headers down to the persistable safe set. */
function pickSafeHeaders(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  headers.forEach((value, key) => {
    if (SAFE_RESPONSE_HEADERS.has(key.toLowerCase())) out[key.toLowerCase()] = value;
  });
  return out;
}

/** Reconstruct a `Response` from a cache entry so callers stay unaware. */
export function responseFromCache(entry: CacheEntry): Response {
  const body = entry.response.sseText ?? entry.response.bodyText ?? "";
  const headers = new Headers(entry.response.headers);
  // Default content-type if missing so SSE parsing still works.
  if (!headers.has("content-type")) {
    headers.set("content-type", entry.response.sseText ? "text/event-stream" : "application/json");
  }
  return new Response(body, {
    status: entry.response.status,
    statusText: entry.response.statusText,
    headers,
  });
}

/**
 * Wrap a real `Response` so that the body is tee'd: the caller still consumes
 * the live stream while we buffer a copy. On end-of-stream we persist the
 * buffered body via `onFinalize`. If the buffer exceeds the size cap we drop
 * it and skip the cache write.
 *
 * Used for streaming (text/event-stream) responses. Non-streaming JSON goes
 * through `recordJsonResponse` instead.
 */
export function teeStreamResponse(
  response: Response,
  onFinalize: (sseText: string | null, headers: Record<string, string>, status: number, statusText: string) => void
): Response {
  if (!response.body) {
    onFinalize("", pickSafeHeaders(response.headers), response.status, response.statusText);
    return response;
  }

  const safeHeaders = pickSafeHeaders(response.headers);
  const status = response.status;
  const statusText = response.statusText;

  let buffer = "";
  let dropped = false;
  const decoder = new TextDecoder();

  const transformed = response.body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        if (!dropped) {
          buffer += decoder.decode(chunk, { stream: true });
          if (buffer.length > STREAM_BUFFER_LIMIT_BYTES) {
            console.warn(
              `[replay-cache] Stream exceeded ${STREAM_BUFFER_LIMIT_BYTES} bytes; cache write skipped.`
            );
            dropped = true;
            buffer = "";
          }
        }
        controller.enqueue(chunk);
      },
      flush() {
        if (dropped) {
          onFinalize(null, safeHeaders, status, statusText);
        } else {
          buffer += decoder.decode();
          onFinalize(buffer, safeHeaders, status, statusText);
        }
      },
    })
  );

  return new Response(transformed, { status, statusText, headers: response.headers });
}

/** Helper: persist a non-streaming JSON response. */
export async function recordJsonResponse(
  hash: string,
  method: string,
  url: string,
  body: unknown,
  response: Response
): Promise<Response> {
  const cloned = response.clone();
  let bodyText = "";
  try {
    bodyText = await cloned.text();
  } catch (err) {
    console.warn(`[replay-cache] Failed to read response body:`, err instanceof Error ? err.message : err);
    return response;
  }
  saveCached(hash, {
    request: {
      method: method.toUpperCase(),
      url,
      body: redact(body),
      bodyHash: hash,
      recordedAt: new Date().toISOString(),
    },
    response: {
      status: response.status,
      statusText: response.statusText,
      headers: pickSafeHeaders(response.headers),
      bodyText,
    },
  });
  return response;
}

/** Helper: build a streaming cache entry from finalized buffer. */
export function buildStreamEntry(
  hash: string,
  method: string,
  url: string,
  body: unknown,
  sseText: string,
  headers: Record<string, string>,
  status: number,
  statusText: string
): CacheEntry {
  return {
    request: {
      method: method.toUpperCase(),
      url,
      body: redact(body),
      bodyHash: hash,
      recordedAt: new Date().toISOString(),
    },
    response: { status, statusText, headers, sseText },
  };
}

/** Internal — used only by tests to ensure the index dir parent exists. */
export function _ensureCacheDirForTest(): void {
  mkdirSync(dirname(entryPath("x")), { recursive: true });
}
