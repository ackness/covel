import { describe, expect, it } from "vitest";
import { mediaRefSchema } from "@covel/shared";
import type { MediaStore } from "../media-store.js";

const PNG = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
const OTHER = new Uint8Array([1, 2, 3, 4]);

async function toUint8Array(value: Uint8Array | Blob): Promise<Uint8Array> {
	if (value instanceof Uint8Array) return value;
	return new Uint8Array(await value.arrayBuffer());
}

export function runMediaStoreContractTests(
	name: string,
	createStore: () => MediaStore | Promise<MediaStore>,
): void {
	describe(`MediaStore Contract: ${name}`, () => {
		it("stores bytes as a MediaRef and reads them back", async () => {
			const store = await createStore();
			const ref = await store.put(PNG, "image/png", { width: 1, height: 1 });

			expect(mediaRefSchema.parse(ref)).toEqual(ref);
			expect(ref.mime).toBe("image/png");
			expect(ref.size).toBe(PNG.byteLength);
			expect(ref.meta).toEqual({ width: 1, height: 1 });
			expect(await store.exists(ref.id)).toBe(true);

			const bytes = await toUint8Array(await store.get(ref));
			expect([...bytes]).toEqual([...PNG]);
		});

		it("deduplicates identical content by sha256 id", async () => {
			const store = await createStore();

			const a = await store.put(PNG, "image/png");
			const b = await store.put(PNG, "image/png");
			const c = await store.put(OTHER, "application/octet-stream");

			expect(a.id).toBe(b.id);
			expect(a.id).not.toBe(c.id);
		});

		it("keeps metadata immutable for duplicate content", async () => {
			const store = await createStore();

			const first = await store.put(PNG, "image/png", { label: "first" });
			await store.recordOwnership(first.id, "sess-A", "plugin-A");
			const second = await store.put(PNG, "image/jpeg", { label: "second" });

			expect(second).toEqual(first);
			const lookup = await store.lookup(first.id);
			expect(lookup?.mime).toBe("image/png");
			expect(lookup?.size).toBe(PNG.byteLength);
			expect(lookup?.ownerSessionId).toBe("sess-A");
			expect(lookup?.ownerPluginId).toBe("plugin-A");
		});

		it("resolves a readable URL for stored media", async () => {
			const store = await createStore();
			const ref = await store.put(PNG, "image/png");

			const url = await store.resolveUrl(ref);
			expect(url).toMatch(
				/^(memory:\/\/media\/|file:\/\/|pg:\/\/media\/|s3:\/\/|https?:\/\/|blob:)/,
			);
			if (!url.startsWith("blob:")) {
				expect(url).toContain(ref.id);
			}
		});

		it("prefers a MediaRef url when provided", async () => {
			const store = await createStore();
			const ref = await store.put(PNG, "image/png");
			const url = "https://example.test/signed";

			await expect(store.resolveUrl({ ...ref, url })).resolves.toBe(url);
		});

		it("accepts Blob input and returns content-addressed bytes", async () => {
			const store = await createStore();
			const blob = new Blob([PNG], { type: "image/png" });

			const ref = await store.put(blob, "image/png");

			expect(ref.size).toBe(PNG.byteLength);
			expect(await store.exists(ref.id)).toBe(true);
			expect([...(await toUint8Array(await store.get(ref)))]).toEqual([...PNG]);
		});

		it("deletes stored media by id", async () => {
			const store = await createStore();
			const ref = await store.put(PNG, "image/png");

			await store.delete(ref.id);

			expect(await store.exists(ref.id)).toBe(false);
			await expect(store.get(ref)).rejects.toThrow(ref.id);
		});

		// ── Ownership / refs / streaming (P0-a §5.1 g/h) ───────────────

		it("lookup returns null for unknown ids and metadata for stored ones", async () => {
			const store = await createStore();
			expect(await store.lookup("does-not-exist")).toBeNull();

			const ref = await store.put(PNG, "image/png");
			const lookup = await store.lookup(ref.id);
			expect(lookup).not.toBeNull();
			expect(lookup?.id).toBe(ref.id);
			expect(lookup?.mime).toBe("image/png");
			expect(lookup?.size).toBe(PNG.byteLength);
			// Ownership defaults to null until recordOwnership runs.
			expect(lookup?.ownerSessionId).toBeNull();
			expect(lookup?.ownerPluginId).toBeNull();
		});

		it("records ownership idempotently and does not overwrite a different session", async () => {
			const store = await createStore();
			const ref = await store.put(PNG, "image/png");

			await store.recordOwnership(ref.id, "sess-A", "plugin-X");
			let lookup = await store.lookup(ref.id);
			expect(lookup?.ownerSessionId).toBe("sess-A");
			expect(lookup?.ownerPluginId).toBe("plugin-X");

			// Idempotent re-record by same session is a no-op.
			await store.recordOwnership(ref.id, "sess-A", "plugin-X");
			lookup = await store.lookup(ref.id);
			expect(lookup?.ownerSessionId).toBe("sess-A");

			// First-writer wins: a different session must NOT steal ownership.
			await store.recordOwnership(ref.id, "sess-B", "plugin-Y");
			lookup = await store.lookup(ref.id);
			expect(lookup?.ownerSessionId).toBe("sess-A");
			expect(lookup?.ownerPluginId).toBe("plugin-X");
		});

		it("addRef + isReferencedBy lets non-owner sessions reach the asset", async () => {
			const store = await createStore();
			const ref = await store.put(PNG, "image/png");
			await store.recordOwnership(ref.id, "sess-A");

			// Owner is implicitly referenced.
			expect(await store.isReferencedBy(ref.id, "sess-A")).toBe(true);
			// Other sessions are not, until addRef runs.
			expect(await store.isReferencedBy(ref.id, "sess-B")).toBe(false);

			await store.addRef(ref.id, "sess-B", "plugin-Y");
			expect(await store.isReferencedBy(ref.id, "sess-B")).toBe(true);

			// addRef is idempotent — second call must not throw on the unique index.
			await store.addRef(ref.id, "sess-B", "plugin-Y");
			expect(await store.isReferencedBy(ref.id, "sess-B")).toBe(true);

			// Unknown sessions still report false.
			expect(await store.isReferencedBy(ref.id, "sess-C")).toBe(false);
		});

		it("addRef is idempotent on (sessionId, mediaId) regardless of pluginId", async () => {
			// The UNIQUE constraint on media_refs is (session_id, media_id) only —
			// plugin_id is "first-source metadata", not part of the key. SQL UNIQUE
			// treats every NULL as distinct, so the previous (s,m,plugin_id) key
			// silently allowed unbounded duplicate rows when pluginId was undefined.
			// This contract pins the new behaviour across every backend.
			const store = await createStore();
			const ref = await store.put(PNG, "image/png");

			// Two NULL-pluginId addRefs collapse to a single row.
			await store.addRef(ref.id, "sess-X");
			await store.addRef(ref.id, "sess-X");
			let refs = (await store.listRefs()).filter(
				(r) => r.sessionId === "sess-X" && r.mediaId === ref.id,
			);
			expect(refs).toHaveLength(1);
			expect(refs[0]?.pluginId).toBeNull();

			// A subsequent addRef with a different pluginId is a no-op (first
			// writer wins) — the row count stays at 1 and the original pluginId
			// (NULL) is preserved.
			await store.addRef(ref.id, "sess-X", "plugin-late");
			refs = (await store.listRefs()).filter(
				(r) => r.sessionId === "sess-X" && r.mediaId === ref.id,
			);
			expect(refs).toHaveLength(1);
			expect(refs[0]?.pluginId).toBeNull();

			// Same idempotency holds when the first write provided a pluginId.
			await store.addRef(ref.id, "sess-Y", "plugin-A");
			await store.addRef(ref.id, "sess-Y", "plugin-B");
			const yRefs = (await store.listRefs()).filter(
				(r) => r.sessionId === "sess-Y" && r.mediaId === ref.id,
			);
			expect(yRefs).toHaveLength(1);
			expect(yRefs[0]?.pluginId).toBe("plugin-A");
		});

		it("lists assets and refs for lifecycle scans", async () => {
			const store = await createStore();
			const ref = await store.put(PNG, "image/png", { label: "scan" });
			await store.recordOwnership(ref.id, "sess-A", "plugin-X");
			await store.addRef(ref.id, "sess-B", "plugin-Y");

			const assets = await store.listAssets();
			const asset = assets.find((item) => item.id === ref.id);
			expect(asset).toMatchObject({
				id: ref.id,
				mime: "image/png",
				size: PNG.byteLength,
				ownerSessionId: "sess-A",
				ownerPluginId: "plugin-X",
			});
			expect(asset?.createdAt).toEqual(expect.any(String));

			const refs = await store.listRefs();
			expect(refs).toContainEqual(
				expect.objectContaining({
					mediaId: ref.id,
					sessionId: "sess-B",
					pluginId: "plugin-Y",
				}),
			);
		});

		it("cleanup supports dry-run and protected ids", async () => {
			const store = await createStore();
			const keep = await store.put(PNG, "image/png");
			const remove = await store.put(OTHER, "application/octet-stream");

			const dryRun = await store.cleanup(new Set([keep.id]), {
				maxBytes: keep.size,
				dryRun: true,
			});
			expect(dryRun.deletedIds).toEqual([remove.id]);
			expect(dryRun.bytesDeleted).toBe(remove.size);
			expect(await store.exists(remove.id)).toBe(true);

			const result = await store.cleanup(new Set([keep.id]), {
				maxBytes: keep.size,
			});
			expect(result.deletedIds).toEqual([remove.id]);
			expect(result.protectedIds).toEqual([keep.id]);
			expect(await store.exists(keep.id)).toBe(true);
			expect(await store.exists(remove.id)).toBe(false);
		});

		it("isReferencedBy returns true purely from ownership when no addRef ran", async () => {
			const store = await createStore();
			const ref = await store.put(PNG, "image/png");
			await store.recordOwnership(ref.id, "sess-OWNER");

			expect(await store.isReferencedBy(ref.id, "sess-OWNER")).toBe(true);
		});

		it("openReadStream returns the full byte sequence for ~1 MiB assets", async () => {
			const store = await createStore();
			if (typeof store.openReadStream !== "function") {
				// Optional capability — skip when the backend opts out.
				return;
			}
			// 1 MiB of pseudo-random-but-deterministic bytes so we exercise
			// multi-chunk reads in the SQLite createReadStream path without
			// pulling in a CSPRNG dependency.
			const big = new Uint8Array(1 * 1024 * 1024);
			for (let i = 0; i < big.byteLength; i += 1) {
				big[i] = (i * 2654435761) & 0xff;
			}
			const ref = await store.put(big, "application/octet-stream");

			const stream = await store.openReadStream(ref);
			const reader = stream.getReader();
			const chunks: Uint8Array[] = [];
			let total = 0;
			// eslint-disable-next-line no-constant-condition
			while (true) {
				const { done, value } = await reader.read();
				if (done) break;
				if (!value) continue;
				chunks.push(value);
				total += value.byteLength;
			}
			expect(total).toBe(big.byteLength);

			const combined = new Uint8Array(total);
			let offset = 0;
			for (const c of chunks) {
				combined.set(c, offset);
				offset += c.byteLength;
			}
			// Spot-check head, tail, and middle to catch any silent corruption.
			expect(combined[0]).toBe(big[0]);
			expect(combined[big.byteLength - 1]).toBe(big[big.byteLength - 1]);
			expect(combined[big.byteLength / 2]).toBe(big[big.byteLength / 2]);
		});
	});
}
