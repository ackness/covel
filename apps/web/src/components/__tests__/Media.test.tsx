/**
 * Behavioural tests for `<Media>`.
 *
 * Covers:
 *   - MediaRef → image / audio / video routing by mime
 *   - sentinel placeholder when resolution fails
 *   - blob URL revoked on unmount
 *
 * Network and IDB are stubbed inline so the tests do not depend on
 * `fake-indexeddb` (not hoisted into apps/web/node_modules).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, cleanup } from "@testing-library/react";

import { Media } from "../Media.js";
import { __resetMediaCacheForTests } from "../../lib/media-cache.js";
import { sha256Hex } from "../../lib/media-hash.js";
import type { MediaRef } from "@covel/shared";

const PAYLOAD_BYTES = new TextEncoder().encode("payload");
async function makeRef(mime: string): Promise<MediaRef> {
	const buffer = PAYLOAD_BYTES.buffer.slice(
		PAYLOAD_BYTES.byteOffset,
		PAYLOAD_BYTES.byteOffset + PAYLOAD_BYTES.byteLength,
	) as ArrayBuffer;
	const id = await sha256Hex(buffer);
	return { id, mime, size: PAYLOAD_BYTES.byteLength };
}

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
	delete(): FakeReq {
		const req = mk();
		queueMicrotask(() => req.onsuccess?.());
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

// ── Test harness ───────────────────────────────────────────────────

const realIDB = (globalThis as { indexedDB?: unknown }).indexedDB;
const realFetch = globalThis.fetch;
const realCreateObjectURL = globalThis.URL.createObjectURL;
const realRevokeObjectURL = globalThis.URL.revokeObjectURL;

let revokeSpy: ReturnType<typeof vi.fn>;
let urlCounter = 0;

beforeEach(() => {
	dbInstances.clear();
	__resetMediaCacheForTests();
	(globalThis as unknown as { indexedDB: unknown }).indexedDB = fakeIndexedDB();
	urlCounter = 0;
	globalThis.URL.createObjectURL = vi.fn(
		() => "blob:test/" + ++urlCounter,
	) as unknown as typeof URL.createObjectURL;
	revokeSpy = vi.fn();
	globalThis.URL.revokeObjectURL =
		revokeSpy as unknown as typeof URL.revokeObjectURL;
});

afterEach(() => {
	cleanup();
	if (realIDB === undefined) {
		delete (globalThis as { indexedDB?: unknown }).indexedDB;
	} else {
		(globalThis as unknown as { indexedDB: unknown }).indexedDB = realIDB;
	}
	globalThis.fetch = realFetch;
	globalThis.URL.createObjectURL = realCreateObjectURL;
	globalThis.URL.revokeObjectURL = realRevokeObjectURL;
});

function setFetchToBlob(mime: string): void {
	globalThis.fetch = vi.fn(async (input: string | URL | Request) => {
		const url =
			typeof input === "string"
				? input
				: input instanceof URL
					? input.href
					: (input as Request).url;
		if (url.startsWith("/api/sessions/")) {
			return new Response(
				JSON.stringify({ url: "https://signed.example/media?token=ok" }),
				{ status: 200, headers: { "Content-Type": "application/json" } },
			);
		}
		// jsdom's `Response(Blob)` stringifies to "[object Blob]" — feed the
		// raw bytes directly so the body length matches the ref.size promised.
		return new Response(new Uint8Array(PAYLOAD_BYTES), {
			status: 200,
			headers: { "Content-Type": mime },
		});
	}) as unknown as typeof globalThis.fetch;
}

function setFetchAlwaysFails(): void {
	globalThis.fetch = vi.fn(
		async () => new Response("nope", { status: 500 }),
	) as unknown as typeof globalThis.fetch;
}

// ── Tests ──────────────────────────────────────────────────────────

describe("<Media>", () => {
	it("renders <img> for MediaRef with image mime", async () => {
		const ref: MediaRef = {
			...(await makeRef("image/png")),
			url: "https://cdn.example/a.png",
		};
		setFetchToBlob("image/png");
		render(<Media src={ref} sessionId="s1" alt="picture" />);
		await waitFor(() => {
			const img = screen.getByAltText("picture") as HTMLImageElement;
			expect(img.tagName).toBe("IMG");
			expect(img.src.startsWith("blob:")).toBe(true);
		});
	});

	it("renders <audio> for MediaRef with audio mime", async () => {
		const ref: MediaRef = {
			...(await makeRef("audio/mp3")),
			url: "https://cdn.example/a.mp3",
		};
		setFetchToBlob("audio/mp3");
		const { container } = render(<Media src={ref} sessionId="s1" alt="song" />);
		await waitFor(() => {
			const audio = container.querySelector("audio");
			expect(audio).not.toBeNull();
			expect(audio?.getAttribute("src")?.startsWith("blob:")).toBe(true);
			expect(audio?.hasAttribute("controls")).toBe(true);
		});
	});

	it("renders <video> for MediaRef with video mime", async () => {
		const ref: MediaRef = {
			...(await makeRef("video/mp4")),
			url: "https://cdn.example/a.mp4",
		};
		setFetchToBlob("video/mp4");
		const { container } = render(<Media src={ref} sessionId="s1" alt="clip" />);
		await waitFor(() => {
			const video = container.querySelector("video");
			expect(video).not.toBeNull();
			expect(video?.getAttribute("src")?.startsWith("blob:")).toBe(true);
			expect(video?.hasAttribute("controls")).toBe(true);
		});
	});

	it("renders unavailable state when resolution fails", async () => {
		const ref: MediaRef = {
			...(await makeRef("image/png")),
			url: "https://broken.example/missing.png",
		};
		setFetchAlwaysFails();
		render(<Media src={ref} sessionId="s1" alt="oops" />);
		await waitFor(() => {
			expect(screen.getByRole("img", { name: "oops" })).toBeTruthy();
			expect(screen.queryByAltText("oops")).toBeNull();
		});
	});

	it("revokes blob URL on unmount", async () => {
		const ref: MediaRef = {
			...(await makeRef("image/png")),
			url: "https://cdn.example/r.png",
		};
		setFetchToBlob("image/png");
		const { unmount } = render(<Media src={ref} sessionId="s1" alt="temp" />);
		await waitFor(() => {
			const img = screen.getByAltText("temp") as HTMLImageElement;
			expect(img.src.startsWith("blob:")).toBe(true);
		});
		unmount();
		expect(revokeSpy).toHaveBeenCalled();
	});

	it("respects `as` override for image-mime payloads", async () => {
		const ref: MediaRef = {
			...(await makeRef("application/octet-stream")),
			url: "https://cdn.example/blob.bin",
		};
		setFetchToBlob("application/octet-stream");
		const { container } = render(
			<Media src={ref} sessionId="s1" alt="forced-audio" as="audio" />,
		);
		await waitFor(() => {
			expect(container.querySelector("audio")).not.toBeNull();
		});
	});
});
