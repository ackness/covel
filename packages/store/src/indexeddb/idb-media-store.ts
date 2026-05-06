import type {
	MediaAssetLookup,
	MediaAssetRecord,
	MediaRef,
	MediaRefRecord,
	MediaStore,
} from "@covel/shared";
import { openDB, type DBSchema, type IDBPDatabase } from "idb";

const DEFAULT_DB_NAME = "covel-media-store";
const DB_VERSION = 2;
const STORE_ASSETS = "media_assets";
const STORE_REFS = "media_refs";

interface IdbMediaAssetRecord {
	readonly id: string;
	readonly mime: string;
	readonly size: number;
	readonly blob: Blob;
	readonly meta?: Readonly<Record<string, unknown>>;
	readonly ownerSessionId: string | null;
	readonly ownerPluginId: string | null;
	readonly createdAt: string;
}

interface IdbMediaRefRecord {
	readonly key: string;
	readonly mediaId: string;
	readonly sessionId: string;
	readonly pluginId: string | null;
	readonly createdAt: string;
}

interface IdbMediaDb extends DBSchema {
	readonly [STORE_ASSETS]: {
		key: string;
		value: IdbMediaAssetRecord;
		indexes: {
			readonly owner: [string, string];
		};
	};
	readonly [STORE_REFS]: {
		key: string;
		value: IdbMediaRefRecord;
		indexes: {
			readonly sessionId: string;
			readonly mediaId: string;
			readonly session_media: [string, string];
		};
	};
}

export interface IndexedDbMediaStoreOptions {
	readonly dbName?: string;
}

async function openMediaDb(dbName: string): Promise<IDBPDatabase<IdbMediaDb>> {
	return openDB<IdbMediaDb>(dbName, DB_VERSION, {
		upgrade(db) {
			if (!db.objectStoreNames.contains(STORE_ASSETS)) {
				const assets = db.createObjectStore(STORE_ASSETS, { keyPath: "id" });
				assets.createIndex("owner", ["ownerSessionId", "ownerPluginId"]);
			}
			if (!db.objectStoreNames.contains(STORE_REFS)) {
				const refs = db.createObjectStore(STORE_REFS, { keyPath: "key" });
				refs.createIndex("sessionId", "sessionId");
				refs.createIndex("mediaId", "mediaId");
				refs.createIndex("session_media", ["sessionId", "mediaId"]);
			}
		},
	});
}

async function toBlobAndBytes(
	value: Uint8Array | Blob,
	fallbackMime: string,
): Promise<{
	readonly blob: Blob;
	readonly bytes: Uint8Array;
}> {
	if (value instanceof Blob) {
		return {
			blob:
				value.type === fallbackMime
					? value
					: value.slice(0, value.size, fallbackMime),
			bytes: new Uint8Array(await value.arrayBuffer()),
		};
	}
	const bytes = new Uint8Array(value);
	return {
		blob: new Blob([bytes], { type: fallbackMime }),
		bytes,
	};
}

function bytesToHex(bytes: ArrayBuffer): string {
	return [...new Uint8Array(bytes)]
		.map((byte) => byte.toString(16).padStart(2, "0"))
		.join("");
}

async function sha256(bytes: Uint8Array): Promise<string> {
	const input = bytes.buffer.slice(
		bytes.byteOffset,
		bytes.byteOffset + bytes.byteLength,
	) as ArrayBuffer;
	const digest = await globalThis.crypto.subtle.digest("SHA-256", input);
	return bytesToHex(digest);
}

function toMediaRef(record: IdbMediaAssetRecord): MediaRef {
	return {
		id: record.id,
		mime: record.mime,
		size: record.size,
		...(record.meta === undefined ? {} : { meta: record.meta }),
	};
}

function toLookup(record: IdbMediaAssetRecord): MediaAssetLookup {
	return {
		id: record.id,
		mime: record.mime,
		size: record.size,
		ownerSessionId: record.ownerSessionId,
		ownerPluginId: record.ownerPluginId,
	};
}

function toAssetRecord(record: IdbMediaAssetRecord): MediaAssetRecord {
	return {
		...toLookup(record),
		createdAt: record.createdAt,
		...(record.meta === undefined ? {} : { meta: record.meta }),
	};
}

// First writer wins — keyed only on (sessionId, mediaId). Mirrors the SQL
// backends' UNIQUE (session_id, media_id) constraint so addRef is idempotent
// regardless of pluginId. The first stored row's pluginId is preserved.
function refKey(mediaId: string, sessionId: string): string {
	return `${sessionId}\u0000${mediaId}`;
}

function cloneMeta(
	meta?: object,
): Readonly<Record<string, unknown>> | undefined {
	return meta === undefined
		? undefined
		: { ...(meta as Record<string, unknown>) };
}

function cleanupCandidates(
	assets: readonly MediaAssetRecord[],
	protectedIds: ReadonlySet<string>,
	policy: {
		readonly maxBytes?: number;
		readonly maxAgeMs?: number;
		readonly keepRecentBytes?: number;
		readonly dryRun?: boolean;
		readonly now?: Date;
	} = {},
): { readonly idsToDelete: readonly string[] } {
	const nowMs = policy.now?.getTime() ?? Date.now();
	const protectedSet = new Set(protectedIds);
	const sorted = [...assets].sort(
		(a, b) =>
			a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id),
	);
	const ids = new Set<string>();
	let currentBytes = sorted.reduce((sum, asset) => sum + asset.size, 0);

	if (typeof policy.maxAgeMs === "number" && policy.maxAgeMs >= 0) {
		const cutoff = nowMs - policy.maxAgeMs;
		for (const asset of sorted) {
			if (protectedSet.has(asset.id)) continue;
			const created = Date.parse(asset.createdAt);
			if (Number.isFinite(created) && created <= cutoff) {
				ids.add(asset.id);
				currentBytes -= asset.size;
			}
		}
	}

	if (
		typeof policy.keepRecentBytes === "number" &&
		policy.keepRecentBytes >= 0
	) {
		let recentBytes = 0;
		for (const asset of [...sorted].reverse()) {
			if (protectedSet.has(asset.id) || ids.has(asset.id)) continue;
			recentBytes += asset.size;
			if (recentBytes > policy.keepRecentBytes) {
				ids.add(asset.id);
				currentBytes -= asset.size;
			}
		}
	}

	if (typeof policy.maxBytes === "number" && policy.maxBytes >= 0) {
		for (const asset of sorted) {
			if (currentBytes <= policy.maxBytes) break;
			if (protectedSet.has(asset.id) || ids.has(asset.id)) continue;
			ids.add(asset.id);
			currentBytes -= asset.size;
		}
	}

	return { idsToDelete: [...ids] };
}

export async function createIndexedDbMediaStore(
	options?: IndexedDbMediaStoreOptions,
): Promise<MediaStore> {
	const db = await openMediaDb(options?.dbName ?? DEFAULT_DB_NAME);

	async function deleteAsset(id: string): Promise<void> {
		const tx = db.transaction([STORE_ASSETS, STORE_REFS], "readwrite");
		await Promise.all([
			tx.objectStore(STORE_ASSETS).delete(id),
			(async () => {
				let cursor = await tx
					.objectStore(STORE_REFS)
					.index("mediaId")
					.openCursor(id);
				while (cursor) {
					await cursor.delete();
					cursor = await cursor.continue();
				}
			})(),
		]);
		await tx.done;
	}

	return {
		async put(value, mime, meta) {
			const { blob, bytes } = await toBlobAndBytes(value, mime);
			const id = await sha256(bytes);
			const existing = await db.get(STORE_ASSETS, id);
			if (existing) return toMediaRef(existing);

			const record: IdbMediaAssetRecord = {
				id,
				mime,
				size: bytes.byteLength,
				blob,
				...(meta === undefined ? {} : { meta: cloneMeta(meta) }),
				ownerSessionId: null,
				ownerPluginId: null,
				createdAt: new Date().toISOString(),
			};
			await db.put(STORE_ASSETS, record);
			return toMediaRef(record);
		},

		async get(ref) {
			const record = await db.get(STORE_ASSETS, ref.id);
			if (!record) throw new Error(`Media asset not found: ${ref.id}`);
			return record.blob;
		},

		async exists(id) {
			return (await db.getKey(STORE_ASSETS, id)) !== undefined;
		},

		async resolveUrl(ref) {
			if (ref.url) return ref.url;
			const record = await db.get(STORE_ASSETS, ref.id);
			if (!record) throw new Error(`Media asset not found: ${ref.id}`);
			return URL.createObjectURL(record.blob);
		},

		async delete(id) {
			await deleteAsset(id);
		},

		async lookup(id) {
			const record = await db.get(STORE_ASSETS, id);
			return record ? toLookup(record) : null;
		},

		async recordOwnership(id, ownerSessionId, ownerPluginId) {
			const record = await db.get(STORE_ASSETS, id);
			if (!record) return;
			if (
				record.ownerSessionId !== null &&
				record.ownerSessionId !== ownerSessionId
			)
				return;
			await db.put(STORE_ASSETS, {
				...record,
				ownerSessionId,
				ownerPluginId: ownerPluginId ?? null,
			});
		},

		async addRef(id, sessionId, pluginId) {
			const exists = await db.getKey(STORE_ASSETS, id);
			if (exists === undefined) return;
			const key = refKey(id, sessionId);
			// First-writer wins on plugin_id: skip the put if a row already exists.
			const existingRef = await db.get(STORE_REFS, key);
			if (existingRef) return;
			await db.put(STORE_REFS, {
				key,
				mediaId: id,
				sessionId,
				pluginId: pluginId ?? null,
				createdAt: new Date().toISOString(),
			});
		},

		async isReferencedBy(id, sessionId) {
			const record = await db.get(STORE_ASSETS, id);
			if (record?.ownerSessionId === sessionId) return true;
			const key = await db.getKeyFromIndex(STORE_REFS, "session_media", [
				sessionId,
				id,
			]);
			return key !== undefined;
		},

		async listAssets() {
			const rows = await db.getAll(STORE_ASSETS);
			return rows
				.map(toAssetRecord)
				.sort(
					(a, b) =>
						a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id),
				);
		},

		async listRefs() {
			const rows = await db.getAll(STORE_REFS);
			return rows
				.map(
					(row): MediaRefRecord => ({
						mediaId: row.mediaId,
						sessionId: row.sessionId,
						pluginId: row.pluginId,
						createdAt: row.createdAt,
					}),
				)
				.sort(
					(a, b) =>
						a.createdAt.localeCompare(b.createdAt) ||
						a.sessionId.localeCompare(b.sessionId) ||
						a.mediaId.localeCompare(b.mediaId),
				);
		},

		async cleanup(protectedIds, policy = {}) {
			const assets = (await db.getAll(STORE_ASSETS))
				.map(toAssetRecord)
				.sort(
					(a, b) =>
						a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id),
				);
			const { idsToDelete } = cleanupCandidates(assets, protectedIds, policy);
			const deletedSet = new Set(idsToDelete);
			const totalBytes = assets.reduce((sum, asset) => sum + asset.size, 0);
			const bytesDeleted = assets
				.filter((asset) => deletedSet.has(asset.id))
				.reduce((sum, asset) => sum + asset.size, 0);

			if (!policy.dryRun) {
				for (const id of idsToDelete) {
					await deleteAsset(id);
				}
			}

			return {
				scanned: assets.length,
				protected: assets.filter((asset) => protectedIds.has(asset.id)).length,
				retained: assets.length - idsToDelete.length,
				deleted: idsToDelete.length,
				totalBytes,
				bytesDeleted,
				bytesRetained: totalBytes - bytesDeleted,
				protectedIds: [...protectedIds].sort(),
				deletedIds: idsToDelete,
			};
		},

		async openReadStream(ref) {
			const record = await db.get(STORE_ASSETS, ref.id);
			if (!record) throw new Error(`Media asset not found: ${ref.id}`);
			return record.blob.stream() as ReadableStream<Uint8Array>;
		},
	};
}
