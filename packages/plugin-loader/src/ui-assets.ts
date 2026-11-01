import { createHash } from "node:crypto";
import { constants, lstatSync, readdirSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import {
  PLUGIN_ASSET_RESERVED_DIR,
  PLUGIN_THEME_BITMAP_MIME,
  MAX_PLUGIN_THEME_BITMAP_FILES,
  MAX_PLUGIN_THEME_BITMAP_BYTES,
  MAX_PLUGIN_THEME_BITMAP_FILE_BYTES,
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
export interface IndexedPluginAssetFile extends PluginAssetFile {
  readonly sha256: string;
}
export interface PluginAssetRoot {
  readonly pluginId: string;
  readonly digest: string;
  readonly rootDir: string;
  readonly purpose: "page" | "theme";
  readonly entry?: string;
  readonly files: ReadonlyMap<string, IndexedPluginAssetFile>;
}

/** Root-relative regular files, plus markers for reserved directory names. */
export function planPluginAssetRoot(
  files: readonly { relativePath: string; size: number }[],
  entry: string | { purpose: "theme" },
): { listed: Map<string, PluginAssetFile>; issues: PluginUiSpecIssue[] } {
  const theme = typeof entry !== "string";
  const field = theme ? "assets.root" : "webview.root";
  const listed = new Map<string, PluginAssetFile>();
  const issues: PluginUiSpecIssue[] = [];
  const issue = (message: string) => issues.push({ path: field, message });
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
    const mime = theme
      ? PLUGIN_THEME_BITMAP_MIME[
          extension.slice(1) as keyof typeof PLUGIN_THEME_BITMAP_MIME
        ]
      : MIME[extension];
    if (!mime || (extension === ".html" && file.relativePath !== entry))
      continue;
    listed.set(file.relativePath, { mime, size: file.size });
    if (
      file.size >
      (theme ? MAX_PLUGIN_THEME_BITMAP_FILE_BYTES : MAX_PLUGIN_ASSET_FILE_BYTES)
    )
      issue(`${file.relativePath} exceeds ${theme ? 2 : 8} MiB`);
  }
  if (!theme && !listed.has(entry as string))
    issues.push({
      path: "webview.entry",
      message: "entry is missing or is not a listed UI file",
    });
  if (!listed.size)
    issue(`${field} has no listed ${theme ? "bitmap" : "UI"} files`);
  if (
    listed.size >
    (theme ? MAX_PLUGIN_THEME_BITMAP_FILES : MAX_PLUGIN_ASSET_FILES)
  )
    issue(
      `${field} exceeds ${theme ? MAX_PLUGIN_THEME_BITMAP_FILES : MAX_PLUGIN_ASSET_FILES} listed files`,
    );
  if (
    [...listed.values()].reduce((sum, file) => sum + file.size, 0) >
    (theme ? MAX_PLUGIN_THEME_BITMAP_BYTES : MAX_PLUGIN_ASSET_BYTES)
  )
    issue(`${field} exceeds ${theme ? 8 : 32} MiB`);
  return { listed, issues };
}

/** lstat never follows symlinks, including Windows junctions. */
export function listPluginAssetFiles(
  root: string,
  options?: { rejectLinks: boolean },
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
      if (options?.rejectLinks && stat.isSymbolicLink())
        throw new Error("theme assets must not contain links");
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
  const listed = new Map<string, IndexedPluginAssetFile>();
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
        const bytes = Buffer.alloc(metadata.size + 1);
        let length = 0;
        while (length < bytes.length) {
          const read = await handle.read(bytes, length, bytes.length - length);
          if (!read.bytesRead) break;
          length += read.bytesRead;
        }
        if (length !== metadata.size)
          throw new Error("UI asset changed while indexing");
        const contentHash = createHash("sha256")
          .update(bytes.subarray(0, length))
          .digest("hex");
        listed.set(relativePath, { ...metadata, sha256: contentHash });
        hash.update(
          JSON.stringify([relativePath, metadata.size, contentHash]) + "\n",
        );
      } finally {
        await handle.close();
      }
    }
  }
  return {
    ...plan,
    listed: new Map(
      [...plan.listed.keys()].flatMap((key) => {
        const file = listed.get(key);
        return file ? [[key, file] as const] : [];
      }),
    ),
    digest: hash.digest("hex").slice(0, 32),
  };
}
