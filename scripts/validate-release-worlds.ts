#!/usr/bin/env tsx

import { readFile } from "node:fs/promises";
import path from "node:path";
import YAML from "yaml";
import {
  formatValidationErrors,
  validateWorldManifest,
} from "../packages/shared/src/index.js";
import { loadWorldDataSummary } from "../apps/server/src/world-data/world-load.js";

const worldDirs = process.argv.slice(2);
if (worldDirs.length === 0) {
  console.error("Usage: validate-release-worlds.ts <world-dir>...");
  process.exit(2);
}

let failed = false;
for (const worldDir of worldDirs) {
  const manifestPath = path.join(worldDir, "world.yaml");
  let raw: unknown;
  try {
    raw = YAML.parse(await readFile(manifestPath, "utf-8"));
  } catch (error) {
    failed = true;
    console.error(
      `✗ ${manifestPath}: ${error instanceof Error ? error.message : String(error)}`,
    );
    continue;
  }

  const validation = validateWorldManifest(raw);
  if (!validation.valid) {
    failed = true;
    console.error(`✗ ${manifestPath} (world manifest schema)`);
    console.error(formatValidationErrors(validation.errors ?? []));
    continue;
  }

  const manifest = validation.data as Record<string, unknown>;
  const result = await loadWorldDataSummary({
    worldRoot: worldDir,
    worldId: String(manifest.id),
    ...(typeof manifest.worldData === "string"
      ? { worldDataPath: manifest.worldData }
      : {}),
  });
  const errors = result.diagnostics.filter(
    (diagnostic) => diagnostic.level === "error",
  );
  if (errors.length > 0) {
    failed = true;
    console.error(`✗ ${manifestPath} (worldData diagnostics)`);
    for (const diagnostic of errors) {
      console.error(
        `  - ${diagnostic.sourceId ? `${diagnostic.sourceId}: ` : ""}${diagnostic.message}`,
      );
    }
    continue;
  }
  console.log(`✓ ${manifestPath}`);
}

if (failed) process.exit(1);
