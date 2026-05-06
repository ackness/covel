import { lstat, realpath } from "node:fs/promises";
import path from "node:path";

function isInsideRoot(
	rootRealPath: string,
	candidateRealPath: string,
): boolean {
	const rel = path.relative(rootRealPath, candidateRealPath);
	return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

export async function resolveContainedPath(
	root: string,
	relativePath: string,
	options?: { rejectSymlinks?: boolean; mustExist?: boolean },
): Promise<string | null> {
	if (path.isAbsolute(relativePath)) return null;

	const rootRealPath = await realpath(root);
	const resolved = path.resolve(rootRealPath, relativePath);
	const lexicalRel = path.relative(rootRealPath, resolved);
	if (lexicalRel.startsWith("..") || path.isAbsolute(lexicalRel)) {
		return null;
	}

	let stat;
	try {
		stat = await lstat(resolved);
	} catch {
		if (options?.mustExist === false) return resolved;
		return null;
	}

	if (options?.rejectSymlinks && stat.isSymbolicLink()) return null;

	const realResolved = await realpath(resolved);
	return isInsideRoot(rootRealPath, realResolved) ? realResolved : null;
}

export function isHiddenPathSegment(relativePath: string): boolean {
	return relativePath
		.split(/[\\/]+/)
		.some((segment) => segment.startsWith(".") || segment === "node_modules");
}
