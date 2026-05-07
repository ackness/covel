import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import { digestFile, sha256Hex } from "./digest.js";
import type { OrderedWorldDataSource, WorldDataDiagnostic } from "./types.js";

const MAX_MEDIA_FILE_BYTES = 20 * 1024 * 1024;
const MAX_MEDIA_SOURCE_BYTES = 100 * 1024 * 1024;
const ALLOWED_EXTENSIONS = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".webp",
  ".mp3",
  ".wav",
  ".mp4",
]);

export interface MediaSourceSummary {
  readonly count: number;
  readonly bytes: number;
  readonly digest: string;
}

export async function summarizeMediaSource(
  source: OrderedWorldDataSource,
  resolvedPath: string,
): Promise<{
  summary?: MediaSourceSummary;
  diagnostics: readonly WorldDataDiagnostic[];
}> {
  const diagnostics: WorldDataDiagnostic[] = [];
  const sourceStat = await stat(resolvedPath);
  const files: string[] = [];

  if (sourceStat.isDirectory()) {
    const entries = await readdir(resolvedPath, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      if (!entry.isFile()) continue;
      files.push(path.join(resolvedPath, entry.name));
    }
  } else if (sourceStat.isFile()) {
    files.push(resolvedPath);
  } else {
    diagnostics.push({
      level: "error",
      sourceId: source.id,
      path: source.descriptor.path,
      message: "media source must be a file or directory",
    });
    return { diagnostics };
  }

  files.sort((a, b) => a.localeCompare(b));
  let totalBytes = 0;
  const parts: string[] = [];
  for (const file of files) {
    const ext = path.extname(file).toLowerCase();
    if (!ALLOWED_EXTENSIONS.has(ext)) {
      diagnostics.push({
        level: "warning",
        sourceId: source.id,
        path: path.relative(path.dirname(resolvedPath), file),
        message: `media file extension is not in v1 allowlist: ${ext}`,
      });
      continue;
    }
    const fileStat = await stat(file);
    if (fileStat.size > MAX_MEDIA_FILE_BYTES) {
      diagnostics.push({
        level: "error",
        sourceId: source.id,
        path: path.relative(path.dirname(resolvedPath), file),
        message: `media file exceeds ${MAX_MEDIA_FILE_BYTES} bytes`,
      });
      continue;
    }
    totalBytes += fileStat.size;
    if (totalBytes > MAX_MEDIA_SOURCE_BYTES) {
      diagnostics.push({
        level: "error",
        sourceId: source.id,
        path: source.descriptor.path,
        message: `media source exceeds ${MAX_MEDIA_SOURCE_BYTES} bytes`,
      });
      break;
    }
    const digest = await digestFile(file);
    parts.push(`${path.basename(file)}:${digest.digest}:${digest.size}`);
  }

  return {
    summary: {
      count: parts.length,
      bytes: totalBytes,
      digest: sha256Hex(parts.join("\n")),
    },
    diagnostics,
  };
}
