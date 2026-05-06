/**
 * Import plugins and world packages from local files.
 *
 * Accepts either:
 *   - A directory path (copied recursively into the target user dir)
 *   - A .zip archive (extracted into the target user dir)
 *
 * Validation is intentionally strict:
 *   - Plugin imports require a PLUGIN.md at the root or inside runtimes/*
 *   - World imports require a world.yaml at the root
 *   - Zip entries are filtered for zip-slip / absolute paths / symlinks
 *
 * The web tier can reach these via IPC (`covel:import:plugin`, `covel:import:world`).
 */

import fs from "node:fs";
import path from "node:path";
import { userPluginsDir, userWorldsDir } from "./paths.js";

export type ImportKind = "plugin" | "world";

export interface ImportResult {
	readonly ok: boolean;
	readonly kind: ImportKind;
	readonly targetPath?: string;
	readonly itemName?: string;
	readonly message?: string;
}

function isDirectorySafe(p: string): boolean {
	try {
		return fs.statSync(p).isDirectory();
	} catch {
		return false;
	}
}

function isFileSafe(p: string): boolean {
	try {
		return fs.statSync(p).isFile();
	} catch {
		return false;
	}
}

/** Sanitize an entry name inside an archive — reject anything that escapes root. */
function safeEntryPath(rawName: string): string | null {
	if (!rawName) return null;
	// Disallow absolute paths and Windows drive letters
	if (rawName.startsWith("/") || /^[a-zA-Z]:[\\/]/.test(rawName)) return null;
	// Normalize and ensure we stay inside the target root
	const normalized = path.posix.normalize(rawName.replace(/\\/g, "/"));
	if (normalized.startsWith("..") || normalized.includes("/../")) return null;
	// Reject names with NUL bytes
	if (normalized.includes("\0")) return null;
	return normalized;
}

/** Lightweight ZIP reader (central directory only, uses native zlib for inflate). */
async function extractZipSafely(
	zipPath: string,
	targetDir: string,
): Promise<{ entries: number; rootPrefix: string | null }> {
	const zlib = await import("node:zlib");
	const { promisify } = await import("node:util");
	const inflateRaw = promisify(zlib.inflateRaw);

	const buf = fs.readFileSync(zipPath);
	// Find end-of-central-directory record
	const EOCD_SIG = 0x06054b50;
	let eocdOffset = -1;
	for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i -= 1) {
		if (buf.readUInt32LE(i) === EOCD_SIG) {
			eocdOffset = i;
			break;
		}
	}
	if (eocdOffset < 0) throw new Error("Invalid zip: EOCD not found");

	const totalEntries = buf.readUInt16LE(eocdOffset + 10);
	const cdSize = buf.readUInt32LE(eocdOffset + 12);
	const cdOffset = buf.readUInt32LE(eocdOffset + 16);
	if (cdOffset + cdSize > buf.length)
		throw new Error("Invalid zip: CD out of range");

	const CD_SIG = 0x02014b50;
	const LFH_SIG = 0x04034b50;

	let cursor = cdOffset;
	let extracted = 0;
	const rootPrefixes = new Set<string>();

	for (let i = 0; i < totalEntries; i += 1) {
		if (cursor + 46 > buf.length)
			throw new Error("Invalid zip: CD header truncated");
		if (buf.readUInt32LE(cursor) !== CD_SIG)
			throw new Error("Invalid zip: bad CD signature");

		const method = buf.readUInt16LE(cursor + 10);
		const compressedSize = buf.readUInt32LE(cursor + 20);
		const uncompressedSize = buf.readUInt32LE(cursor + 24);
		const nameLen = buf.readUInt16LE(cursor + 28);
		const extraLen = buf.readUInt16LE(cursor + 30);
		const commentLen = buf.readUInt16LE(cursor + 32);
		const externalAttr = buf.readUInt32LE(cursor + 38);
		const localOffset = buf.readUInt32LE(cursor + 42);
		const rawName = buf
			.slice(cursor + 46, cursor + 46 + nameLen)
			.toString("utf-8");

		cursor += 46 + nameLen + extraLen + commentLen;

		// Reject symlinks — the high 4 bits of externalAttr encode the Unix
		// file type. 0xA000 = S_IFLNK.
		if (((externalAttr >>> 16) & 0xf000) === 0xa000) {
			throw new Error(`Zip entry refuses symlink: ${rawName}`);
		}

		const safe = safeEntryPath(rawName);
		if (safe === null) {
			throw new Error(`Zip entry refuses unsafe path: ${rawName}`);
		}

		// Track root-level prefix (first path segment) to detect "single top-level dir" archives
		const firstSeg = safe.split("/")[0];
		if (firstSeg) rootPrefixes.add(firstSeg);

		const isDir =
			safe.endsWith("/") ||
			(uncompressedSize === 0 && compressedSize === 0 && safe.endsWith("/"));
		const outPath = path.join(targetDir, safe);
		// Defence in depth: ensure resolved path is still inside targetDir
		const rel = path.relative(targetDir, outPath);
		if (rel.startsWith("..") || path.isAbsolute(rel)) {
			throw new Error(`Zip entry escapes target dir: ${rawName}`);
		}

		if (isDir) {
			fs.mkdirSync(outPath, { recursive: true });
			continue;
		}

		// Read local file header to locate the data
		if (localOffset + 30 > buf.length)
			throw new Error("Invalid zip: LFH truncated");
		if (buf.readUInt32LE(localOffset) !== LFH_SIG)
			throw new Error("Invalid zip: bad LFH signature");
		const lfhNameLen = buf.readUInt16LE(localOffset + 26);
		const lfhExtraLen = buf.readUInt16LE(localOffset + 28);
		const dataStart = localOffset + 30 + lfhNameLen + lfhExtraLen;
		const dataEnd = dataStart + compressedSize;
		if (dataEnd > buf.length) throw new Error("Invalid zip: data out of range");

		const compressed = buf.slice(dataStart, dataEnd);
		let output: Buffer;
		if (method === 0) {
			output = compressed;
		} else if (method === 8) {
			output = await inflateRaw(compressed);
		} else {
			throw new Error(`Unsupported zip compression method: ${method}`);
		}

		fs.mkdirSync(path.dirname(outPath), { recursive: true });
		fs.writeFileSync(outPath, output);
		extracted += 1;
	}

	// If all entries share a single top-level dir we consider that the "package root"
	const rootPrefix =
		rootPrefixes.size === 1 ? Array.from(rootPrefixes.values())[0] : null;

	return { entries: extracted, rootPrefix };
}

// ── Validators ─────────────────────────────────────────────────

function pluginMdExists(root: string): boolean {
	if (isFileSafe(path.join(root, "PLUGIN.md"))) return true;
	const runtimesDir = path.join(root, "runtimes");
	if (!isDirectorySafe(runtimesDir)) return false;
	for (const entry of fs.readdirSync(runtimesDir, { withFileTypes: true })) {
		if (
			entry.isDirectory() &&
			isFileSafe(path.join(runtimesDir, entry.name, "PLUGIN.md"))
		) {
			return true;
		}
	}
	return false;
}

function worldYamlExists(root: string): boolean {
	return isFileSafe(path.join(root, "world.yaml"));
}

// ── Copy directory recursively ─────────────────────────────────

function copyDirRecursive(src: string, dst: string): void {
	fs.mkdirSync(dst, { recursive: true });
	for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
		// Skip symlinks outright — we refuse to propagate them.
		if (entry.isSymbolicLink()) continue;
		const s = path.join(src, entry.name);
		const d = path.join(dst, entry.name);
		if (entry.isDirectory()) {
			copyDirRecursive(s, d);
		} else if (entry.isFile()) {
			fs.copyFileSync(s, d);
		}
	}
}

// ── Public API ─────────────────────────────────────────────────

export async function importAsset(
	kind: ImportKind,
	sourcePath: string,
): Promise<ImportResult> {
	if (!sourcePath)
		return { ok: false, kind, message: "No source path provided" };
	if (!fs.existsSync(sourcePath)) {
		return { ok: false, kind, message: `Source does not exist: ${sourcePath}` };
	}

	const targetRoot = kind === "plugin" ? userPluginsDir() : userWorldsDir();
	fs.mkdirSync(targetRoot, { recursive: true });

	const validate = kind === "plugin" ? pluginMdExists : worldYamlExists;

	// Branch: directory copy vs zip extraction
	if (isDirectorySafe(sourcePath)) {
		if (!validate(sourcePath)) {
			return {
				ok: false,
				kind,
				message:
					kind === "plugin"
						? "Directory does not contain PLUGIN.md"
						: "Directory does not contain world.yaml",
			};
		}
		const name = path.basename(sourcePath);
		const targetDir = path.join(targetRoot, name);
		if (fs.existsSync(targetDir)) {
			return {
				ok: false,
				kind,
				itemName: name,
				message: `Already exists: ${name}`,
			};
		}
		copyDirRecursive(sourcePath, targetDir);
		return { ok: true, kind, targetPath: targetDir, itemName: name };
	}

	if (isFileSafe(sourcePath) && /\.zip$/i.test(sourcePath)) {
		// Extract to a temp dir first so we can validate before committing
		const tmpDir = fs.mkdtempSync(path.join(targetRoot, ".import-"));
		try {
			const { rootPrefix } = await extractZipSafely(sourcePath, tmpDir);
			const validateRoot = rootPrefix ? path.join(tmpDir, rootPrefix) : tmpDir;
			if (!validate(validateRoot)) {
				return {
					ok: false,
					kind,
					message:
						kind === "plugin"
							? "Zip does not contain PLUGIN.md"
							: "Zip does not contain world.yaml",
				};
			}
			const name = rootPrefix ?? path.basename(sourcePath, ".zip");
			const targetDir = path.join(targetRoot, name);
			if (fs.existsSync(targetDir)) {
				return {
					ok: false,
					kind,
					itemName: name,
					message: `Already exists: ${name}`,
				};
			}
			// Move validated content into place. If rootPrefix, move that subdir,
			// otherwise move the whole tmp dir contents under a new dir.
			if (rootPrefix) {
				fs.renameSync(validateRoot, targetDir);
			} else {
				fs.renameSync(tmpDir, targetDir);
				return { ok: true, kind, targetPath: targetDir, itemName: name };
			}
			return { ok: true, kind, targetPath: targetDir, itemName: name };
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			return { ok: false, kind, message };
		} finally {
			// Best-effort cleanup if tmpDir still exists
			try {
				if (fs.existsSync(tmpDir)) {
					fs.rmSync(tmpDir, { recursive: true, force: true });
				}
			} catch {
				/* ignore */
			}
		}
	}

	return {
		ok: false,
		kind,
		message: "Unsupported source (expected a folder or a .zip file)",
	};
}
