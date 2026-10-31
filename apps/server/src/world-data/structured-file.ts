import { readFile, stat } from "node:fs/promises";
import type { BigIntStats } from "node:fs";
import { parse as parseYaml } from "yaml";
import { createRevisionCache } from "./revision-cache.js";

const readCached = createRevisionCache<unknown>(64);

/** Callers still enforce containment, regular-file and size checks before reading. */
export async function readStructuredFile(
  file: string,
  kind: "json" | "yaml",
  checkedStat?: BigIntStats,
): Promise<unknown> {
  const info = checkedStat ?? (await stat(file, { bigint: true }));
  const revision = [
    info.dev,
    info.ino,
    info.size,
    info.mtimeNs,
    info.ctimeNs,
  ].join(":");
  return readCached(JSON.stringify([file, kind]), revision, async () => {
    const text = await readFile(file, "utf-8");
    return kind === "json" ? JSON.parse(text) : parseYaml(text);
  });
}
