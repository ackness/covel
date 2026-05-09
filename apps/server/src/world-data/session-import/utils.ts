import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { parse as parseYaml } from "yaml";

export async function fileExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function sourceItems(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : [value];
}

export async function readWorldManifest(worldRoot: string): Promise<{
  id?: string;
  worldData?: string;
}> {
  const raw = parseYaml(
    await readFile(path.join(worldRoot, "world.yaml"), "utf-8"),
  );
  return isRecord(raw)
    ? {
        id: typeof raw.id === "string" ? raw.id : undefined,
        worldData:
          typeof raw.worldData === "string" ? raw.worldData : undefined,
      }
    : {};
}

export async function resolveWorldRoot(
  worldId: string,
  worldsDirs: readonly string[],
): Promise<string | null> {
  for (const worldsDir of [...worldsDirs].reverse()) {
    const candidate = path.join(worldsDir, worldId);
    if (!(await fileExists(path.join(candidate, "world.yaml")))) continue;
    const manifest = await readWorldManifest(candidate);
    if (manifest.id === worldId) return candidate;
  }
  return null;
}
