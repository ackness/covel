import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import { digestFile, sha256Hex } from "./digest.js";
import type { OrderedWorldDataSource, WorldDataDiagnostic } from "./types.js";

export const MAX_MEDIA_FILE_BYTES = 20 * 1024 * 1024;
const MAX_MEDIA_SOURCE_BYTES = 100 * 1024 * 1024;
/** The file types a media source imports. */
export const MEDIA_SOURCE_EXTENSIONS: ReadonlySet<string> = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".webp",
  ".mp3",
  ".wav",
  ".mp4",
]);

function megabytes(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export interface MediaSourceFiles {
  readonly files: readonly string[];
  readonly bytes: number;
  readonly digest: string;
  readonly diagnostics: readonly WorldDataDiagnostic[];
}

export async function collectMediaSourceFiles(
  source: OrderedWorldDataSource,
  resolvedPath: string,
): Promise<MediaSourceFiles> {
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
      message: `media source "${source.id}" must name a file or a directory; ${source.descriptor.path} is neither`,
    });
    return { files: [], bytes: 0, digest: sha256Hex(""), diagnostics };
  }

  // A file is named as the author finds it: by its path in the package.
  const packagePath = (file: string): string =>
    sourceStat.isDirectory()
      ? path.posix.join(
          source.descriptor.path.replaceAll("\\", "/"),
          path.basename(file),
        )
      : source.descriptor.path;

  files.sort((a, b) => a.localeCompare(b));
  let totalBytes = 0;
  const parts: string[] = [];
  const acceptedFiles: string[] = [];
  for (const file of files) {
    const ext = path.extname(file).toLowerCase();
    if (!MEDIA_SOURCE_EXTENSIONS.has(ext)) {
      diagnostics.push({
        level: "warning",
        sourceId: source.id,
        path: packagePath(file),
        message: `${packagePath(file)} is not imported: a media source reads ${[...MEDIA_SOURCE_EXTENSIONS].join(", ")} files, not ${ext || "files without an extension"}`,
        hint: "Convert the file to one of these types, or move it out of the media directory.",
      });
      continue;
    }
    const fileStat = await stat(file);
    if (fileStat.size > MAX_MEDIA_FILE_BYTES) {
      diagnostics.push({
        level: "error",
        sourceId: source.id,
        path: packagePath(file),
        message: `${packagePath(file)} is ${megabytes(fileStat.size)}; a media file may be at most ${megabytes(MAX_MEDIA_FILE_BYTES)}`,
        hint: "Compress or resize the file, or remove it from the media directory.",
      });
      continue;
    }
    totalBytes += fileStat.size;
    if (totalBytes > MAX_MEDIA_SOURCE_BYTES) {
      diagnostics.push({
        level: "error",
        sourceId: source.id,
        path: source.descriptor.path,
        message: `media source "${source.id}" passes ${megabytes(MAX_MEDIA_SOURCE_BYTES)} in total at ${packagePath(file)}`,
        hint: "Compress the files, or split the directory into several media sources.",
      });
      break;
    }
    const digest = await digestFile(file);
    parts.push(`${path.basename(file)}:${digest.digest}:${digest.size}`);
    acceptedFiles.push(file);
  }

  return {
    files: acceptedFiles,
    bytes: totalBytes,
    digest: sha256Hex(parts.join("\n")),
    diagnostics,
  };
}
