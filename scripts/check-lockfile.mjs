import {
  copyFileSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  mkdirSync,
  rmSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import crossSpawn from "cross-spawn";

const defaultRoot = fileURLToPath(new URL("..", import.meta.url));

export function checkLockfile(repoRoot = defaultRoot, pnpm = "pnpm") {
  const scratch = mkdtempSync(path.join(os.tmpdir(), "covel-lockfile-"));
  try {
    for (const filename of [
      "package.json",
      "pnpm-workspace.yaml",
      "pnpm-lock.yaml",
    ]) {
      copyFileSync(path.join(repoRoot, filename), path.join(scratch, filename));
    }
    for (const group of ["apps", "packages", "plugins"]) {
      const groupDir = path.join(repoRoot, group);
      if (!existsSync(groupDir)) continue;
      for (const entry of readdirSync(groupDir, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const manifest = path.join(groupDir, entry.name, "package.json");
        if (!existsSync(manifest)) continue;
        const targetDir = path.join(scratch, group, entry.name);
        mkdirSync(targetDir, { recursive: true });
        copyFileSync(manifest, path.join(targetDir, "package.json"));
      }
    }

    // pnpm validates every workspace importer without downloading packages,
    // running lifecycle scripts, or touching the caller's node_modules.
    const result = crossSpawn.sync(
      pnpm,
      [
        "install",
        "--lockfile-only",
        "--frozen-lockfile",
        "--ignore-scripts",
        "--offline",
      ],
      { cwd: scratch, encoding: "utf8" },
    );
    if (result.error) throw result.error;
    if (result.status !== 0) {
      throw new Error(
        `pnpm lockfile validation failed (${result.status}):\n${[result.stdout, result.stderr].filter(Boolean).join("\n").trim()}`,
      );
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    checkLockfile();
    console.log("pnpm lockfile matches workspace manifests.");
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
