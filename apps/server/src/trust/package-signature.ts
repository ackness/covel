import { lstat, readdir } from "node:fs/promises";
import path from "node:path";
import { LIMITS } from "../routes/api/install/shared.js";

/** Never follow links; include receipt metadata so snapshot edits invalidate the cache. */
export async function packageStatSignature(directory: string): Promise<string> {
  const entries: string[] = [];
  async function visit(relative: string): Promise<void> {
    if (entries.length > LIMITS.maxEntries)
      throw new Error("Too many package files");
    const absolute = path.join(directory, relative);
    const stat = await lstat(absolute, { bigint: true });
    entries.push(
      JSON.stringify([
        relative,
        String(stat.mode),
        String(stat.size),
        String(stat.mtimeNs),
        String(stat.ctimeNs),
        String(stat.ino),
      ]),
    );
    if (stat.isDirectory() && !stat.isSymbolicLink()) {
      for (const name of (await readdir(absolute)).sort())
        await visit(relative ? `${relative}/${name}` : name);
    }
  }
  await visit("");
  return entries.sort().join("\n");
}
