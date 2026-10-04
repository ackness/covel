#!/usr/bin/env tsx

import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  validateWorldPackage,
  type WorldPackageDiagnostic,
} from "../apps/server/src/world-data/validate-world-package.js";

const USAGE = `Usage: pnpm validate:world [--strict] [--plugins <dir>]... <world-dir>...

  --plugins <dir>  Also scan this directory for plugin packages. The bundled
                   plugins/ directory is always scanned.
  --strict         Treat a plugin ID or contract that no scanned plugin supplies
                   as an error instead of a warning.`;

const repoRoot = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const worldDirs: string[] = [];
const pluginsDirs = [path.join(repoRoot, "plugins")];
let strict = false;

const args = process.argv.slice(2);
for (let index = 0; index < args.length; index += 1) {
  const arg = args[index]!;
  if (arg === "--strict") strict = true;
  else if (arg === "--plugins") {
    const dir = args[(index += 1)];
    if (!dir) {
      console.error(USAGE);
      process.exit(2);
    }
    pluginsDirs.push(path.resolve(dir));
  } else if (arg.startsWith("--")) {
    console.error(`Unknown option: ${arg}\n\n${USAGE}`);
    process.exit(2);
  } else worldDirs.push(arg);
}
if (worldDirs.length === 0) {
  console.error(USAGE);
  process.exit(2);
}

function formatDiagnostic(diagnostic: WorldPackageDiagnostic): string {
  const where = [
    diagnostic.file,
    diagnostic.pointer,
    diagnostic.sourceId ? `source "${diagnostic.sourceId}"` : undefined,
    diagnostic.locales?.length
      ? `locale ${diagnostic.locales.join(", ")}`
      : undefined,
  ]
    .filter(Boolean)
    .join(" · ");
  const label = diagnostic.level === "error" ? "error  " : "warning";
  return [
    `  ${label} ${where}`,
    `          ${diagnostic.message}`,
    ...(diagnostic.hint ? [`          ${diagnostic.hint}`] : []),
  ].join("\n");
}

let failed = false;
for (const worldDir of worldDirs) {
  const { diagnostics } = await validateWorldPackage({
    worldDir,
    pluginsDirs,
    strict,
  });
  const errors = diagnostics.filter((item) => item.level === "error");
  const manifestPath = path.join(worldDir, "world.yaml");
  if (errors.length > 0) failed = true;
  const report = diagnostics.map(formatDiagnostic).join("\n");
  if (errors.length > 0) console.error(`✗ ${manifestPath}\n${report}`);
  else console.log(`✓ ${manifestPath}${report ? `\n${report}` : ""}`);
}

if (failed) process.exit(1);
