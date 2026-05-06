import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import "fake-indexeddb/auto";
import { describe, expect, it, vi } from "vitest";
import { runMediaStoreContractTests } from "../src/contract/media-store-contract.js";
import { createIndexedDbMediaStore } from "../src/indexeddb/idb-media-store.js";
import {
	createMemoryMediaStore,
	createPgMediaStore,
	createS3MediaStore,
	createSqliteMediaStore,
	type S3CompatibleMediaClient,
	type S3CompatibleObject,
	type S3CompatibleObjectInfo,
} from "../src/media-store.js";
import { createSqliteS3MetadataAdapter } from "../src/sqlite/sqlite-s3-metadata-adapter.js";

runMediaStoreContractTests("MemoryMediaStore", () => createMemoryMediaStore());

runMediaStoreContractTests("SqliteMediaStore", () => {
	const tmpDir = fs.mkdtempSync(
		path.join(os.tmpdir(), "covel-media-store-test-"),
	);
	return createSqliteMediaStore(path.join(tmpDir, "test.db"), {
		mediaRoot: path.join(tmpDir, "media"),
	});
});

class FakeS3Client implements S3CompatibleMediaClient {
	readonly objects = new Map<string, S3CompatibleObject>();

	async putObject(input: S3CompatibleObject): Promise<void> {
		this.objects.set(input.key, {
			key: input.key,
			bytes: new Uint8Array(input.bytes),
			mime: input.mime,
			...(input.meta === undefined ? {} : { meta: input.meta }),
		});
	}

	async getObject(key: string): Promise<S3CompatibleObject | null> {
		const object = this.objects.get(key);
		if (!object) return null;
		return {
			key,
			bytes: new Uint8Array(object.bytes),
			mime: object.mime,
			...(object.meta === undefined ? {} : { meta: object.meta }),
		};
	}

	async headObject(key: string): Promise<S3CompatibleObjectInfo | null> {
		const object = this.objects.get(key);
		if (!object) return null;
		return {
			key,
			size: object.bytes.byteLength,
			mime: object.mime,
			...(object.meta === undefined ? {} : { meta: object.meta }),
		};
	}

	async deleteObject(key: string): Promise<void> {
		this.objects.delete(key);
	}

	async createSignedGetUrl(key: string): Promise<string> {
		return `https://media.example.test/${key}?signature=test`;
	}
}

// Run the contract suite with the durable SQLite adapter so we exercise the
// production-grade wiring rather than the in-memory fallback (which logs a
// warn and is only intended for dev). A fresh tmp DB per test keeps state
// isolated.
runMediaStoreContractTests("S3MediaStore", () => {
	const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "covel-s3-meta-test-"));
	return createS3MediaStore(new FakeS3Client(), {
		bucket: "covel-test",
		keyPrefix: "media",
		metadataAdapter: createSqliteS3MetadataAdapter(
			path.join(tmpDir, "meta.db"),
		),
	});
});

describe("createS3MediaStore metadata durability", () => {
	it("survives store re-creation when a SQLite metadata adapter is shared", async () => {
		// Same client + same adapter mirror a "process restarts but bucket and
		// metadata DB persist" scenario. Without metadataAdapter the in-memory
		// fallback would lose ownership and the second store's lookup would
		// report ownerSessionId: null (the original P2 finding).
		const tmpDir = fs.mkdtempSync(
			path.join(os.tmpdir(), "covel-s3-meta-persist-"),
		);
		const client = new FakeS3Client();
		const adapter = createSqliteS3MetadataAdapter(path.join(tmpDir, "meta.db"));

		const storeA = createS3MediaStore(client, { metadataAdapter: adapter });
		const ref = await storeA.put(
			new Uint8Array([7, 7, 7, 7]),
			"application/octet-stream",
			{
				label: "persist",
			},
		);
		await storeA.recordOwnership(ref.id, "sess-OWN", "plugin-OWN");
		await storeA.addRef(ref.id, "sess-VIEWER", "plugin-VIEW");

		// Simulate restart: brand-new MediaStore instance pointed at the same
		// bucket and the same adapter.
		const storeB = createS3MediaStore(client, { metadataAdapter: adapter });

		const lookup = await storeB.lookup(ref.id);
		expect(lookup).not.toBeNull();
		expect(lookup?.ownerSessionId).toBe("sess-OWN");
		expect(lookup?.ownerPluginId).toBe("plugin-OWN");
		expect(lookup?.size).toBe(4);

		expect(await storeB.isReferencedBy(ref.id, "sess-OWN")).toBe(true);
		expect(await storeB.isReferencedBy(ref.id, "sess-VIEWER")).toBe(true);
		expect(await storeB.isReferencedBy(ref.id, "sess-OUTSIDER")).toBe(false);

		const refs = await storeB.listRefs();
		expect(refs).toContainEqual(
			expect.objectContaining({
				sessionId: "sess-VIEWER",
				mediaId: ref.id,
				pluginId: "plugin-VIEW",
			}),
		);

		const assets = await storeB.listAssets();
		expect(assets.find((a) => a.id === ref.id)).toMatchObject({
			ownerSessionId: "sess-OWN",
			mime: "application/octet-stream",
			size: 4,
		});
	});

	it("warns once when no metadataAdapter is supplied (in-memory fallback)", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		try {
			createS3MediaStore(new FakeS3Client());
			expect(warn).toHaveBeenCalledTimes(1);
			expect(warn.mock.calls[0]?.[0]).toContain("no metadataAdapter supplied");
		} finally {
			warn.mockRestore();
		}
	});
});

const DATABASE_URL =
	process.env.DATABASE_URL ??
	"postgresql://covel:covel_dev@localhost:5432/covel";

let pgAvailable = false;
try {
	const { default: postgres } = await import("postgres");
	const client = postgres(DATABASE_URL, { connect_timeout: 3 });
	await client`SELECT 1`;
	await client.end();
	pgAvailable = true;
} catch {
	console.warn("PostgreSQL not available, skipping PgMediaStore tests");
}

if (pgAvailable) {
	runMediaStoreContractTests("PgMediaStore", () =>
		createPgMediaStore(DATABASE_URL, { freshSchema: true }),
	);
} else {
	describe("PgMediaStore (skipped)", () => {
		it("skipped — PostgreSQL not available", () => {
			expect(true).toBe(true);
		});
	});
}

let idbCounter = 0;
runMediaStoreContractTests("IndexedDbMediaStore", async () => {
	idbCounter += 1;
	return createIndexedDbMediaStore({
		dbName: `covel-media-store-test-${idbCounter}`,
	});
});
