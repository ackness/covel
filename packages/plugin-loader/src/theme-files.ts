import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  realpathSync,
} from "node:fs";
import path from "node:path";
import { isPathInside } from "./path-containment.js";
import { listPluginAssetFiles } from "./ui-assets.js";

export interface PluginThemeFiles {
  /** Paths are package-relative. Read at most limit + 1 bytes; fail on overflow. */
  read(relativePath: string, limit: number): Uint8Array;
  list(
    relativeDirectory: string,
  ): readonly { relativePath: string; size: number }[];
}

/** Reject links in every parent as well as the final file, including junctions. */
export function diskPluginThemeFiles(root: string): PluginThemeFiles {
  const realRoot = realpathSync(root);
  const contained = (relative: string): string => {
    const resolved = path.resolve(realRoot, relative);
    if (!isPathInside(realRoot, resolved))
      throw new Error("theme path leaves package root");
    let current = realRoot;
    for (const segment of path.relative(realRoot, resolved).split(path.sep)) {
      current = path.join(current, segment);
      if (lstatSync(current).isSymbolicLink())
        throw new Error("theme paths must not contain links");
    }
    if (realpathSync(resolved) !== resolved)
      throw new Error("theme path changed");
    return resolved;
  };
  return {
    read(relative, limit) {
      const file = contained(relative);
      const before = lstatSync(file, { bigint: true });
      if (!before.isFile() || before.size > BigInt(limit))
        throw new Error("theme file missing, unsupported or oversized");
      const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const stat = fstatSync(fd, { bigint: true });
        if (
          !stat.isFile() ||
          stat.ino !== before.ino ||
          stat.size !== before.size
        )
          throw new Error("theme file changed");
        const bytes = Buffer.alloc(Number(stat.size) + 1);
        let length = 0;
        while (length < bytes.length) {
          const read = readSync(fd, bytes, length, bytes.length - length, null);
          if (!read) break;
          length += read;
        }
        const after = fstatSync(fd, { bigint: true });
        if (
          length !== Number(stat.size) ||
          after.size !== stat.size ||
          after.mtimeNs !== stat.mtimeNs ||
          after.ctimeNs !== stat.ctimeNs ||
          contained(relative) !== file ||
          lstatSync(file, { bigint: true }).ino !== stat.ino
        )
          throw new Error("theme file changed");
        return bytes.subarray(0, length);
      } finally {
        closeSync(fd);
      }
    },
    list(relative) {
      const directory = contained(relative);
      return listPluginAssetFiles(directory, { rejectLinks: true }).map(
        (file) => ({
          relativePath: path
            .relative(directory, file.path)
            .split(path.sep)
            .join("/"),
          size: file.size,
        }),
      );
    },
  };
}
