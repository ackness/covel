import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import { resolveI18nText, worldManifestSchema } from "@covel/shared";
import { loadWorldDataSummary } from "../../../world-data/world-load.js";
import { loadSingleWorld } from "../../../world-seed-loader.js";
import { validateWorldBundle } from "./worlds.js";
import { selectPackageEntries } from "./github-source.js";
import {
  httpError,
  materializeEntries,
  type ExtractedEntry,
} from "./shared.js";

export function findWorldDirectories(
  entries: readonly ExtractedEntry[],
  directory: string,
): string[] {
  const files = selectPackageEntries(entries, directory).map(
    (entry) => entry.relativePath,
  );
  if (files.includes("world.yaml")) return [directory];
  const manifests = files.filter(
    (file) =>
      file.endsWith("/world.yaml") &&
      !file
        .split("/")
        .some(
          (segment) => segment.startsWith(".") || segment === "node_modules",
        ),
  );
  if (!manifests.length)
    throw httpError(400, "No world.yaml found in this directory");
  if (manifests.length > 20)
    throw httpError(
      400,
      "Too many worlds; choose a specific world directory URL",
    );
  return manifests
    .sort()
    .map((file) =>
      [directory, file.slice(0, -"/world.yaml".length)]
        .filter(Boolean)
        .join("/"),
    );
}

export async function inspectWorldBundle(entries: readonly ExtractedEntry[]) {
  const { worldId } = validateWorldBundle(entries);
  if (entries.some((entry) => entry.relativePath === ".covel-install.json"))
    throw httpError(
      400,
      "World package contains a reserved installation receipt",
    );
  const manifest = worldManifestSchema.parse(
    parseYaml(
      entries
        .find((entry) => entry.relativePath === "world.yaml")!
        .content.toString("utf8"),
    ),
  );
  // Validate referenced dimensions and world data using the real loader in an
  // isolated directory. No scripts or package managers are executed.
  const temp = await mkdtemp(path.join(os.tmpdir(), "covel-world-preview-"));
  try {
    const directory = path.join(temp, "world");
    await materializeEntries(directory, entries);
    const summary = await loadWorldDataSummary({
      worldRoot: directory,
      worldId,
      worldDataPath: manifest.worldData,
      covelHome: temp,
    });
    if (summary.diagnostics.some((item) => item.level === "error"))
      throw httpError(
        400,
        "World package contains invalid worldData references",
      );
    const record = await loadSingleWorld(directory, { covelHome: temp });
    if (!record)
      throw httpError(
        400,
        "World package contains invalid dimensions or referenced files",
      );
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
  return {
    id: worldId,
    version: manifest.version ?? null,
    description: resolveI18nText(manifest.summary, "en-US") ?? "",
    hasServerCode: false,
  };
}
