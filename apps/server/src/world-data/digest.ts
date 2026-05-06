import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { DigestResult } from "./types.js";

export function sha256Hex(data: string | Uint8Array): string {
	return `sha256:${createHash("sha256").update(data).digest("hex")}`;
}

export async function digestFile(path: string): Promise<DigestResult> {
	const bytes = await readFile(path);
	return {
		digest: sha256Hex(bytes),
		size: bytes.byteLength,
	};
}

export function canonicalJson(value: unknown): string {
	return JSON.stringify(sortJson(value));
}

function sortJson(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(sortJson);
	if (value === null || typeof value !== "object") return value;
	const object = value as Record<string, unknown>;
	return Object.fromEntries(
		Object.keys(object)
			.sort()
			.map((key) => [key, sortJson(object[key])]),
	);
}
