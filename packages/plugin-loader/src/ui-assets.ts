import { createHash } from "node:crypto";
import { constants, lstatSync, readdirSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import {
  PLUGIN_ASSET_RESERVED_DIR,
  type PluginUiSpecIssue,
} from "@covel/shared";

export const MAX_PLUGIN_ASSET_FILES = 512;
export const MAX_PLUGIN_ASSET_BYTES = 32 * 1024 * 1024;
export const MAX_PLUGIN_ASSET_FILE_BYTES = 8 * 1024 * 1024;

const MIME: Readonly<Record<string, string>> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
};
export interface PluginAssetFile {
  readonly mime: string;
  readonly size: number;
}
export interface PluginAssetRoot {
  readonly pluginId: string;
  readonly digest: string;
  readonly rootDir: string;
  readonly entry: string;
  readonly files: ReadonlyMap<string, PluginAssetFile>;
}

/** Root-relative regular files, plus markers for reserved directory names. */
export function planPluginAssetRoot(
  files: readonly { relativePath: string; size: number }[],
  entry: string,
): { listed: Map<string, PluginAssetFile>; issues: PluginUiSpecIssue[] } {
  const listed = new Map<string, PluginAssetFile>();
  const issues: PluginUiSpecIssue[] = [];
  const issue = (message: string) =>
    issues.push({ path: "webview.root", message });
  for (const file of files) {
    const segments = file.relativePath.split("/");
    if (segments.includes(PLUGIN_ASSET_RESERVED_DIR)) {
      issue("the name __covel__ is reserved");
      continue;
    }
    if (
      ["PLUGIN.md", "RUNTIME.md", ".covel-install.json"].includes(
        file.relativePath,
      )
    )
      issue(
        "webview.root must be a directory of UI files, not the package root",
      );
    if (
      segments.some(
        (segment) =>
          !segment ||
          segment.startsWith(".") ||
          segment === "node_modules" ||
          segment.includes("\\") ||
          segment.includes("\0"),
      )
    )
      continue;
    const extension = path.posix.extname(file.relativePath).toLowerCase();
    const mime = MIME[extension];
    if (!mime || (extension === ".html" && file.relativePath !== entry))
      continue;
    listed.set(file.relativePath, { mime, size: file.size });
    if (file.size > MAX_PLUGIN_ASSET_FILE_BYTES)
      issue(`${file.relativePath} exceeds 8 MiB`);
  }
  if (!listed.has(entry))
    issues.push({
      path: "webview.entry",
      message: "entry is missing or is not a listed UI file",
    });
  if (!listed.size) issue("webview.root has no listed UI files");
  if (listed.size > MAX_PLUGIN_ASSET_FILES)
    issue(`webview.root exceeds ${MAX_PLUGIN_ASSET_FILES} listed files`);
  if (
    [...listed.values()].reduce((sum, file) => sum + file.size, 0) >
    MAX_PLUGIN_ASSET_BYTES
  )
    issue("webview.root exceeds 32 MiB");
  return { listed, issues };
}

/** lstat never follows symlinks, including Windows junctions. */
export function listPluginAssetFiles(
  root: string,
): { path: string; size: number }[] {
  const files: { path: string; size: number }[] = [];
  const walk = (directory: string) => {
    for (const name of readdirSync(directory)) {
      const file = path.join(directory, name);
      const stat = lstatSync(file);
      if (
        name === PLUGIN_ASSET_RESERVED_DIR ||
        (directory === root &&
          ["PLUGIN.md", "RUNTIME.md", ".covel-install.json"].includes(name))
      ) {
        files.push({ path: file, size: stat.size });
        continue;
      }
      if (
        name.startsWith(".") ||
        name === "node_modules" ||
        stat.isSymbolicLink()
      )
        continue;
      if (stat.isDirectory()) walk(file);
      else if (stat.isFile()) files.push({ path: file, size: stat.size });
    }
  };
  if (!lstatSync(root).isDirectory())
    throw new Error("webview.root must be a directory");
  walk(root);
  return files;
}

export async function scanPluginAssetRoot(realRoot: string, entry: string) {
  const plan = planPluginAssetRoot(
    listPluginAssetFiles(realRoot).map((file) => ({
      relativePath: path
        .relative(realRoot, file.path)
        .split(path.sep)
        .join("/"),
      size: file.size,
    })),
    entry,
  );
  const hash = createHash("sha256");
  if (!plan.issues.length) {
    for (const [relativePath, metadata] of [...plan.listed].sort(([a], [b]) =>
      a < b ? -1 : a > b ? 1 : 0,
    )) {
      const handle = await fs.open(
        path.join(realRoot, relativePath),
        constants.O_RDONLY | constants.O_NOFOLLOW,
      );
      try {
        const stat = await handle.stat();
        if (!stat.isFile() || stat.size !== metadata.size)
          throw new Error("UI asset changed while indexing");
        const contentHash = createHash("sha256")
          .update(await handle.readFile())
          .digest("hex");
        hash.update(
          JSON.stringify([relativePath, metadata.size, contentHash]) + "\n",
        );
      } finally {
        await handle.close();
      }
    }
  }
  return { ...plan, digest: hash.digest("hex").slice(0, 32) };
}
