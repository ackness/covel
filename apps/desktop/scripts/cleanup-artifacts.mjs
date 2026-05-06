/**
 * Two-phase cleanup for `release/electron/`.
 *
 * Phase 1 — `afterAllArtifactBuild` hook (default export):
 *   Drops auto-update metadata that we never publish:
 *     - *.blockmap
 *     - latest*.yml
 *     - builder-{debug,effective-config}.{yml,yaml}
 *   **Keeps unpacked directories** (`mac-arm64/`, `win-unpacked/`, …) because
 *   downstream steps in the same workflow run still need them — notably
 *   `apps/desktop/scripts/verify-release.mjs`, which inspects
 *   `mac-arm64/Covel.app/Contents/Resources/server/{worlds,plugins,prompts}`
 *   to catch over-broad electron-builder filters.
 *
 * Phase 2 — CLI invocation (`node cleanup-artifacts.mjs --strip-unpacked`):
 *   Same as phase 1 plus removes the unpacked dirs. Wired into the root
 *   `build:electron` script so a local `pnpm build:electron` ends with two
 *   files only (the .dmg and the .zip). CI workflows that need to verify
 *   the unpacked tree do NOT call this — they invoke electron-builder
 *   directly and do their checks before any phase-2 cleanup.
 *
 * Hook contract: return Array<string> of additional artifact paths to
 * publish; we return [].
 */

import path from "node:path";
import fs from "node:fs/promises";
import { fileURLToPath } from "node:url";

const DROP_FILE_PATTERNS = [
	/\.blockmap$/i,
	/^latest.*\.ya?ml$/i,
	/^builder-debug\.ya?ml$/i,
	/^builder-effective-config\.ya?ml$/i,
];

function isUnpackedDir(name) {
	// electron-builder 解包阶段产物：mac, mac-arm64, mac-x64, win-unpacked,
	// win-ia32-unpacked, linux-unpacked, linux-arm64-unpacked, ...
	if (name === "mac" || /^mac-(arm64|x64|universal)$/.test(name)) return true;
	if (name.endsWith("-unpacked")) return true;
	return false;
}

async function runCleanup(outDir, { stripUnpacked }) {
	let entries;
	try {
		entries = await fs.readdir(outDir, { withFileTypes: true });
	} catch {
		return [];
	}

	const removed = [];
	for (const entry of entries) {
		const full = path.join(outDir, entry.name);
		if (entry.isDirectory()) {
			if (stripUnpacked && isUnpackedDir(entry.name)) {
				await fs.rm(full, { recursive: true, force: true });
				removed.push(entry.name + "/");
			}
			continue;
		}
		if (DROP_FILE_PATTERNS.some((re) => re.test(entry.name))) {
			await fs.rm(full, { force: true });
			removed.push(entry.name);
		}
	}

	if (removed.length > 0) {
		const phase = stripUnpacked ? "phase 2 (strip-unpacked)" : "phase 1 (hook)";
		console.log(
			`[cleanup-artifacts] ${phase} removed ${removed.length} item(s): ${removed.join(", ")}`,
		);
	}
	return removed;
}

/** electron-builder `afterAllArtifactBuild` hook — phase 1 only. */
export default async function cleanupArtifacts(context) {
	const outDir = context?.outDir;
	if (!outDir) return [];
	await runCleanup(outDir, { stripUnpacked: false });
	return [];
}

// CLI entry point — phase 2 (also runs phase 1 to handle the case where
// the hook didn't fire, e.g. when this script is invoked manually).
//
// `process.argv[1] === fileURLToPath(import.meta.url)` is the textbook
// check, but it breaks on macOS when one side resolves through `/private`
// and the other doesn't. Comparing basenames is enough — when the file
// is `import()`-ed by electron-builder, `argv[1]` is the builder entry,
// not us, so the basename guard correctly skips the CLI path.
const entryBasename = process.argv[1] ? path.basename(process.argv[1]) : "";
if (entryBasename === "cleanup-artifacts.mjs") {
	// npm scripts run from repo root, so cwd-relative is the right base.
	// Allow `--out=<path>` for callers that need to override.
	const outArg = process.argv.find((a) => a.startsWith("--out="));
	const outDir = outArg
		? path.resolve(outArg.slice("--out=".length))
		: path.join(process.cwd(), "release", "electron");
	const stripUnpacked = process.argv.includes("--strip-unpacked");
	await runCleanup(outDir, { stripUnpacked });
}
