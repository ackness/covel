/**
 * World package file writing.
 *
 * Extracted from create-world.ts: persists inline manifest `dimensions`
 * through the v1 worldData descriptor so generated worlds use the same
 * importer as hand-built world packages.
 */

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { stringify as stringifyYaml } from "yaml";

const GENERATED_WORLD_DATA_PATH = "data/world.data.yaml";
const GENERATED_DIMENSIONS_PATH = "data/dimensions.yaml";

/**
 * If the manifest contains inline `dimensions`, write them through the v1
 * worldData descriptor so generated worlds use the same importer as hand-built
 * world packages.
 */
export async function writeWorldDataFiles(
  worldDir: string,
  manifest: Record<string, unknown>,
): Promise<string[]> {
  const inline = manifest.dimensions as Record<string, unknown> | undefined;
  if (
    !inline ||
    typeof inline !== "object" ||
    Object.keys(inline).length === 0
  ) {
    return [];
  }

  const dataDir = path.join(worldDir, "data");
  await mkdir(dataDir, { recursive: true });

  const dimensionsPath = path.join(worldDir, GENERATED_DIMENSIONS_PATH);
  await writeFile(
    dimensionsPath,
    stringifyYaml(inline, { lineWidth: 0 }),
    "utf-8",
  );

  const descriptorPath = path.join(worldDir, GENERATED_WORLD_DATA_PATH);
  await writeFile(
    descriptorPath,
    stringifyYaml(
      {
        schemaVersion: 1,
        sources: {
          dimensions: {
            kind: "yaml",
            path: GENERATED_DIMENSIONS_PATH,
            schema: "covel://world/dimensions",
            to: "world:metadata.dimensions",
          },
        },
      },
      { lineWidth: 0 },
    ),
    "utf-8",
  );

  delete manifest.dimensions;
  delete manifest.dimensionSources;
  manifest.worldData = GENERATED_WORLD_DATA_PATH;

  return [GENERATED_DIMENSIONS_PATH, GENERATED_WORLD_DATA_PATH];
}
