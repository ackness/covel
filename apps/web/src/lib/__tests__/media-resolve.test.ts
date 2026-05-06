/**
 * Unit tests for `resolveMediaSrc`.
 *
 * Covers the resolution paths in SPEC §5.1 (g):
 *   1. media-token endpoint authorizes the current session
 *   2. (Tauri only) native fast path — but only *after* authorization
 *   3. cache hit (with integrity verification)
 *   4. signed URL fetch (with integrity verification before caching)
 *   5. explicit error result on failure
 *
 * Uses the same minimal IDB shim from `media-cache.test.ts`. The IDB
 * cache is reset between tests so we can isolate the network paths.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { __resetMediaCacheForTests } from "../media-cache.js";
import {
	resolveMediaSrc,
	MEDIA_TOKEN_ENDPOINT,
	__testing,
} from "../media-resolve.js";
import { sha256Hex } from "../media-hash.js";
import type { MediaRef } from "@covel/shared";

// ── Inline minimal IDB shim (same shape as media-cache.test.ts) ────

interface FakeReq<T = unknown> {
	result: T;
	error: unknown;
	onsuccess: (() => void) | null;
	onerror: (() => void) | null;
	onupgradeneeded?: (() => void) | null;
	onblocked?: (() => void) | null;
}

class FakeStore {
	data = new Map<string, unknown>();
	constructor(readonly keyPath: string) {}
	get(key: string): FakeReq {
		const req = mk();
		queueMicrotask(() => {
			req.result = this.data.get(key);
			req.onsuccess?.();
		});
		return req;
	}
	put(record: Record<string, unknown>): FakeReq {
		const req = mk();
		queueMicrotask(() => {
			this.data.set(record[this.keyPath] as string, record);
			req.onsuccess?.();
		});
		return req;
	}
	delete(key: string): FakeReq {
		const req = mk();
		queueMicrotask(() => {
			this.data.delete(key);
			req.onsuccess?.();
		});
		return req;
	}
	openCursor(): FakeReq {
		const req = mk();
		queueMicrotask(() => {
			req.result = null;
			req.onsuccess?.();
		});
		return req;
	}
}
class FakeTx {
	constructor(readonly db: FakeDb) {}
	objectStore(n: string): FakeStore {
		const s = this.db.stores.get(n);
		if (!s) throw new Error("missing store");
		return s;
	}
}
class FakeDb {
	stores = new Map<string, FakeStore>();
	objectStoreNames = { contains: (n: string) => this.stores.has(n) };
	createObjectStore(name: string, opts: { keyPath: string }): FakeStore {
		const s = new FakeStore(opts.keyPath);
		this.stores.set(name, s);
		return s;
	}
	transaction(name: string): FakeTx {
		if (!this.stores.has(name)) throw new Error("no store");
		return new FakeTx(this);
	}
}
function mk<T = unknown>(): FakeReq<T> {
	return {
		result: undefined as T,
		error: null,
		onsuccess: null,
		onerror: null,
	};
}
const dbInstances = new Map<string, FakeDb>();
function fakeIndexedDB() {
	return {
		open(name: string): FakeReq<FakeDb> {
			const req = mk<FakeDb>();
			let db = dbInstances.get(name);
			const isNew = !db;
			if (!db) {
				db = new FakeDb();
				dbInstances.set(name, db);
			}
			queueMicrotask(() => {
				if (isNew) {
					req.result = db as FakeDb;
					req.onupgradeneeded?.();
				}
				req.result = db as FakeDb;
				req.onsuccess?.();
			});
			return req;
		},
	};
}

// ── Test setup ─────────────────────────────────────────────────────

const realIDB = (globalThis as { indexedDB?: unknown }).indexedDB;
const realFetch = globalThis.fetch;
const realCreateObjectURL = globalThis.URL.createObjectURL;
const realRevokeObjectURL = globalThis.URL.revokeObjectURL;
const realWindowTauri = window.__TAURI__;
type TauriInvoke = <T = unknown>(
	command: string,
	args?: Record<string, unknown>,
) => Promise<T>;

let createdUrls: string[] = [];

beforeEach(() => {
	dbInstances.clear();
	__resetMediaCacheForTests();
	(globalThis as unknown as { indexedDB: unknown }).indexedDB = fakeIndexedDB();

	createdUrls = [];
	globalThis.URL.createObjectURL = vi.fn((blob: Blob | MediaSource) => {
		const id = "blob:test/" + (createdUrls.length + 1);
		createdUrls.push(id);
		void blob;
		return id;
	}) as unknown as typeof URL.createObjectURL;
	globalThis.URL.revokeObjectURL = vi.fn();
	delete window.__TAURI__;
});

afterEach(() => {
	if (realIDB === undefined) {
		delete (globalThis as { indexedDB?: unknown }).indexedDB;
	} else {
		(globalThis as unknown as { indexedDB: unknown }).indexedDB = realIDB;
	}
	globalThis.fetch = realFetch;
	globalThis.URL.createObjectURL = realCreateObjectURL;
	globalThis.URL.revokeObjectURL = realRevokeObjectURL;
	if (realWindowTauri === undefined) {
		delete window.__TAURI__;
	} else {
		window.__TAURI__ = realWindowTauri;
	}
});

const PNG_PAYLOAD = "fake-png-bytes";
const PNG_BYTES = new TextEncoder().encode(PNG_PAYLOAD);

/**
 * jsdom's `Response` constructor stringifies a `Blob` body into
 * `"[object Blob]"` instead of preserving the bytes. To avoid that we
 * always feed `Response` a `Uint8Array` directly. The downstream call
 * site (`fetchBlobAndCache`) still receives a real `Blob` via
 * `res.blob()`.
 */
function pngBytes(): Uint8Array {
	return new Uint8Array(PNG_BYTES);
}

function pngBlob(): Blob {
	return new Blob([PNG_PAYLOAD], { type: "image/png" });
}

function bytesToArrayBuffer(bytes: Uint8Array): ArrayBuffer {
	return bytes.buffer.slice(
		bytes.byteOffset,
		bytes.byteOffset + bytes.byteLength,
	) as ArrayBuffer;
}

async function pngRef(): Promise<MediaRef> {
	const id = await sha256Hex(bytesToArrayBuffer(PNG_BYTES));
	return { id, mime: "image/png", size: PNG_BYTES.byteLength };
}

function pngResponse(): Response {
	return new Response(bytesToArrayBuffer(pngBytes()), {
		status: 200,
		headers: { "Content-Type": "image/png" },
	});
}

function mockFetch(
	handler: (url: string) => Response | Promise<Response>,
): void {
	globalThis.fetch = vi.fn(async (input: string | URL | Request) => {
		const url =
			typeof input === "string"
				? input
				: input instanceof URL
					? input.href
					: (input as Request).url;
		return handler(url);
	}) as unknown as typeof globalThis.fetch;
}

// ── Tests ──────────────────────────────────────────────────────────

describe("MEDIA_TOKEN_ENDPOINT", () => {
	it("encodes both sessionId and id", () => {
		const out = MEDIA_TOKEN_ENDPOINT("abc/def", "id with space");
		expect(out).toBe(
			"/api/sessions/abc%2Fdef/media-token?id=id%20with%20space",
		);
	});
});

describe("resolveMediaSrc", () => {
	it("uses the server-issued signed URL after authorization", async () => {
		const baseRef = await pngRef();
		const refWithUrl: MediaRef = {
			...baseRef,
			url: "https://cdn.example.com/abc.png",
		};
		const calls: string[] = [];
		mockFetch(async (url) => {
			calls.push(url);
			if (url.startsWith("/api/sessions/")) {
				return new Response(
					JSON.stringify({
						url: "https://signed.example.com/abc.png?token=xyz",
					}),
					{ status: 200, headers: { "Content-Type": "application/json" } },
				);
			}
			return pngResponse();
		});
		const result = await resolveMediaSrc(refWithUrl, { sessionId: "s1" });
		expect(calls).toEqual([
			MEDIA_TOKEN_ENDPOINT("s1", baseRef.id),
			"https://signed.example.com/abc.png?token=xyz",
		]);
		expect(result.fromCache).toBe(false);
		expect(result.ok).toBe(true);
		expect(result.url.startsWith("blob:")).toBe(true);
		expect(result.blob).toBeInstanceOf(Blob);
	});

	it("uses the Tauri native media bridge ONLY after the session token authorizes", async () => {
		const baseRef = await pngRef();
		const tokenCalls: string[] = [];
		const tauriCalls: string[] = [];
		mockFetch(async (url) => {
			tokenCalls.push(url);
			if (url.startsWith("/api/sessions/")) {
				return new Response(
					JSON.stringify({ url: "https://signed.example.com/x.png?token=ok" }),
					{ status: 200, headers: { "Content-Type": "application/json" } },
				);
			}
			// Should never be hit because the Tauri native path returns first.
			tauriCalls.push("UNEXPECTED " + url);
			return pngResponse();
		});
		const invoke = vi.fn(
			async (command: string, args?: Record<string, unknown>) => {
				tauriCalls.push(command);
				expect(command).toBe("native_media_read");
				expect(args).toEqual({ id: baseRef.id });
				return {
					id: baseRef.id,
					size: baseRef.size,
					bytes: Array.from(PNG_BYTES),
				};
			},
		);
		window.__TAURI__ = {
			core: { invoke: invoke as unknown as TauriInvoke },
		};

		const result = await resolveMediaSrc(baseRef, { sessionId: "s-tauri" });

		expect(tokenCalls[0]).toBe(MEDIA_TOKEN_ENDPOINT("s-tauri", baseRef.id));
		// Only the token call should have hit fetch — the signed URL never gets pulled.
		expect(tokenCalls).toHaveLength(1);
		expect(tauriCalls).toEqual(["native_media_read"]);
		expect(result.ok).toBe(true);
		expect(result.fromCache).toBe(true);
		expect(result.blob).toBeInstanceOf(Blob);
		expect(result.url.startsWith("blob:")).toBe(true);
	});

	it("does NOT consult the Tauri native media bridge when the token endpoint fails", async () => {
		const baseRef = await pngRef();
		mockFetch(async () => new Response("nope", { status: 401 }));
		const invoke = vi.fn();
		window.__TAURI__ = {
			core: { invoke: invoke as unknown as TauriInvoke },
		};

		const result = await resolveMediaSrc(baseRef, { sessionId: "s-stranger" });

		expect(invoke).not.toHaveBeenCalled();
		expect(result.ok).toBe(false);
		expect(result.url).toBe(__testing.TRANSPARENT_PNG_DATA_URI);
	});

	it("falls back to media-token endpoint when ref.url is absent (path 3)", async () => {
		const baseRef = await pngRef();
		const calls: string[] = [];
		mockFetch(async (url) => {
			calls.push(url);
			if (url.startsWith("/api/sessions/")) {
				return new Response(
					JSON.stringify({
						url: "https://signed.example.com/sha256-abc?token=xyz",
					}),
					{ status: 200, headers: { "Content-Type": "application/json" } },
				);
			}
			return pngResponse();
		});
		const result = await resolveMediaSrc(baseRef, { sessionId: "s2" });
		expect(calls[0]).toBe(MEDIA_TOKEN_ENDPOINT("s2", baseRef.id));
		expect(calls[1]).toBe("https://signed.example.com/sha256-abc?token=xyz");
		expect(result.url.startsWith("blob:")).toBe(true);
		expect(result.fromCache).toBe(false);
		expect(result.ok).toBe(true);
	});

	it("returns an error result when authorization fails", async () => {
		const baseRef = await pngRef();
		mockFetch(async () => new Response("nope", { status: 500 }));
		const result = await resolveMediaSrc(
			{ ...baseRef, url: "https://broken.example.com/x.png" },
			{ sessionId: "s3" },
		);
		expect(result.url).toBe(__testing.TRANSPARENT_PNG_DATA_URI);
		expect(result.fromCache).toBe(false);
		expect(result.ok).toBe(false);
	});

	it("uses cache hit after authorizing the session", async () => {
		const baseRef = await pngRef();
		const refWithUrl: MediaRef = {
			...baseRef,
			url: "https://cdn.example.com/cached.png",
		};
		let tokenFetchCount = 0;
		let blobFetchCount = 0;
		mockFetch(async (url) => {
			if (url.startsWith("/api/sessions/")) {
				tokenFetchCount += 1;
				return new Response(
					JSON.stringify({
						url: "https://signed.example.com/cached.png?token=xyz",
					}),
					{ status: 200, headers: { "Content-Type": "application/json" } },
				);
			}
			blobFetchCount += 1;
			return pngResponse();
		});

		const first = await resolveMediaSrc(refWithUrl, { sessionId: "s4" });
		expect(first.fromCache).toBe(false);
		expect(first.ok).toBe(true);
		expect(tokenFetchCount).toBe(1);
		expect(blobFetchCount).toBe(1);

		const second = await resolveMediaSrc(refWithUrl, { sessionId: "s4" });
		expect(second.fromCache).toBe(true);
		expect(second.ok).toBe(true);
		expect(tokenFetchCount).toBe(2);
		expect(blobFetchCount).toBe(1);
		expect(second.url.startsWith("blob:")).toBe(true);
	});

	it("does not serve a cached blob when a different session fails authorization", async () => {
		const baseRef = await pngRef();
		const refWithUrl: MediaRef = {
			...baseRef,
			url: "https://cdn.example.com/cached.png",
		};
		mockFetch(async (url) => {
			if (url.startsWith("/api/sessions/s4/")) {
				return new Response(
					JSON.stringify({
						url: "https://signed.example.com/cached.png?token=xyz",
					}),
					{ status: 200, headers: { "Content-Type": "application/json" } },
				);
			}
			if (url.startsWith("/api/sessions/s5/")) {
				return new Response("forbidden", { status: 403 });
			}
			return pngResponse();
		});

		const first = await resolveMediaSrc(refWithUrl, { sessionId: "s4" });
		expect(first.ok).toBe(true);

		const second = await resolveMediaSrc(refWithUrl, { sessionId: "s5" });
		expect(second.fromCache).toBe(false);
		expect(second.ok).toBe(false);
		expect(second.url).toBe(__testing.TRANSPARENT_PNG_DATA_URI);
	});

	it("ignores stale ref.url and fetches via the token endpoint", async () => {
		const baseRef = await pngRef();
		const refWithUrl: MediaRef = {
			...baseRef,
			url: "https://broken.example.com/x.png",
		};
		const calls: string[] = [];
		mockFetch(async (url) => {
			calls.push(url);
			if (url.startsWith("/api/sessions/")) {
				return new Response(
					JSON.stringify({ url: "https://recovered.example.com/x.png" }),
					{ status: 200, headers: { "Content-Type": "application/json" } },
				);
			}
			return pngResponse();
		});
		const result = await resolveMediaSrc(refWithUrl, { sessionId: "s5" });
		expect(result.url.startsWith("blob:")).toBe(true);
		expect(calls).toEqual([
			MEDIA_TOKEN_ENDPOINT("s5", baseRef.id),
			"https://recovered.example.com/x.png",
		]);
	});

	it("does not cache a fetched blob whose size disagrees with the ref", async () => {
		// The signed URL serves a different-length payload than ref.size promised.
		// The integrity check must reject it before it pollutes the cache.
		const baseRef = await pngRef();
		let blobFetchCount = 0;
		mockFetch(async (url) => {
			if (url.startsWith("/api/sessions/")) {
				return new Response(
					JSON.stringify({
						url: "https://signed.example.com/wrong-size.png?token=ok",
					}),
					{ status: 200, headers: { "Content-Type": "application/json" } },
				);
			}
			blobFetchCount += 1;
			// Wrong size on purpose:
			return new Response(
				new TextEncoder().encode("a-much-longer-payload-than-the-ref"),
				{
					status: 200,
					headers: { "Content-Type": "image/png" },
				},
			);
		});

		const first = await resolveMediaSrc(baseRef, { sessionId: "s-size" });
		expect(first.ok).toBe(false);
		expect(first.url).toBe(__testing.TRANSPARENT_PNG_DATA_URI);
		expect(blobFetchCount).toBe(1);

		// Now serve the correct payload — should fetch again (cache wasn't poisoned).
		mockFetch(async (url) => {
			if (url.startsWith("/api/sessions/")) {
				return new Response(
					JSON.stringify({
						url: "https://signed.example.com/right.png?token=ok",
					}),
					{ status: 200, headers: { "Content-Type": "application/json" } },
				);
			}
			blobFetchCount += 1;
			return pngResponse();
		});

		const second = await resolveMediaSrc(baseRef, { sessionId: "s-size" });
		expect(second.ok).toBe(true);
		expect(second.fromCache).toBe(false);
		expect(blobFetchCount).toBe(2);
	});

	it("does not cache a fetched blob whose SHA-256 does not match the ref id", async () => {
		// ref.size matches but content differs → SHA mismatch must reject.
		const ref: MediaRef = {
			// intentionally not the SHA of PNG_PAYLOAD
			id: "0".repeat(64),
			mime: "image/png",
			size: PNG_BYTES.byteLength,
		};
		let blobFetchCount = 0;
		mockFetch(async (url) => {
			if (url.startsWith("/api/sessions/")) {
				return new Response(
					JSON.stringify({
						url: "https://signed.example.com/wrong-sha.png?token=ok",
					}),
					{ status: 200, headers: { "Content-Type": "application/json" } },
				);
			}
			blobFetchCount += 1;
			return pngResponse();
		});

		const result = await resolveMediaSrc(ref, { sessionId: "s-sha" });
		expect(result.ok).toBe(false);
		expect(result.url).toBe(__testing.TRANSPARENT_PNG_DATA_URI);
		expect(blobFetchCount).toBe(1);

		// A second call should fetch again — the bad blob was not cached.
		const second = await resolveMediaSrc(ref, { sessionId: "s-sha" });
		expect(second.ok).toBe(false);
		expect(blobFetchCount).toBe(2);
	});

	it("rejects an HTML error page being served at the signed URL (mime + sha mismatch)", async () => {
		const baseRef = await pngRef();
		let blobFetchCount = 0;
		mockFetch(async (url) => {
			if (url.startsWith("/api/sessions/")) {
				return new Response(
					JSON.stringify({
						url: "https://signed.example.com/error.html?token=ok",
					}),
					{ status: 200, headers: { "Content-Type": "application/json" } },
				);
			}
			blobFetchCount += 1;
			return new Response("<html><body>error</body></html>", {
				status: 200,
				headers: { "Content-Type": "text/html" },
			});
		});

		const result = await resolveMediaSrc(baseRef, { sessionId: "s-html" });
		expect(result.ok).toBe(false);
		expect(blobFetchCount).toBe(1);

		// No cache poisoning: a follow-up call should attempt another fetch.
		mockFetch(async (url) => {
			if (url.startsWith("/api/sessions/")) {
				return new Response(
					JSON.stringify({
						url: "https://signed.example.com/right.png?token=ok",
					}),
					{ status: 200, headers: { "Content-Type": "application/json" } },
				);
			}
			blobFetchCount += 1;
			return pngResponse();
		});
		const recovered = await resolveMediaSrc(baseRef, { sessionId: "s-html" });
		expect(recovered.ok).toBe(true);
		expect(blobFetchCount).toBe(2);
	});
});

describe("__testing.verifyBlobAgainstRef", () => {
	it("accepts a blob whose size, mime and SHA-256 all match", async () => {
		const ref = await pngRef();
		const result = await __testing.verifyBlobAgainstRef(pngBlob(), ref);
		expect(result).toBeNull();
	});

	it("returns a size-mismatch reason when sizes diverge", async () => {
		const ref = await pngRef();
		const tooBig = new Blob([PNG_PAYLOAD + "extra"], { type: "image/png" });
		const reason = await __testing.verifyBlobAgainstRef(tooBig, ref);
		expect(reason).toMatch(/size mismatch/);
	});

	it("returns a mime-mismatch reason when types diverge", async () => {
		const ref = await pngRef();
		const wrongType = new Blob([PNG_PAYLOAD], { type: "text/html" });
		const reason = await __testing.verifyBlobAgainstRef(wrongType, ref);
		expect(reason).toMatch(/mime mismatch/);
	});

	it("returns a sha mismatch reason when bytes do not hash to ref.id", async () => {
		const ref: MediaRef = {
			id: "0".repeat(64),
			mime: "image/png",
			size: PNG_BYTES.byteLength,
		};
		const reason = await __testing.verifyBlobAgainstRef(pngBlob(), ref);
		expect(reason).toMatch(/sha256 mismatch/);
	});

	it("ignores trivial mime parameter differences (charset)", () => {
		expect(
			__testing.mimeMatches("image/png; charset=binary", "image/png"),
		).toBe(true);
		expect(__testing.mimeMatches("image/png", "image/png; foo=bar")).toBe(true);
		expect(__testing.mimeMatches("text/html", "image/png")).toBe(false);
	});
});
