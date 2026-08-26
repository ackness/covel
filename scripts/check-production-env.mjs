#!/usr/bin/env node
/**
 * Verify that static production-source env reads are registered in the shared
 * environment registry. Dynamic provider *_API_KEY discovery is intentional.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const registryDirs = ["packages/shared/src/env/groups"];
const ignoredDirs = new Set(["node_modules", "dist", "staging"]);
const helperNames =
  "readEnvString|readEnvInt|readEnvChoice|readEnvCsv|isEnvEnabled|isEnvTruthy|isEnvDefaultOn";

function walk(dir) {
  const files = [];
  if (!fs.existsSync(dir)) return files;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (ignoredDirs.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...walk(full));
    else if (/\.(?:ts|tsx|js|jsx|mjs|mts|cts)$/.test(entry.name))
      files.push(full);
  }
  return files;
}

const registered = new Set();
for (const file of registryDirs.flatMap((dir) =>
  walk(path.join(repoRoot, dir)),
)) {
  const source = fs.readFileSync(file, "utf8");
  for (const match of source.matchAll(/name:\s*["']([A-Z][A-Z0-9_]*)["']/g)) {
    registered.add(match[1]);
  }
}

const findings = [];
const envAccess =
  /process\.env(?:\.([A-Z][A-Z0-9_]*)|\[['"]([A-Z][A-Z0-9_]*)['"]\])/g;
const helperCall = new RegExp(
  `\\b(?:${helperNames})\\(\\s*["']([A-Z][A-Z0-9_]*)["']`,
  "g",
);
const sourceRoots = ["apps", "packages"].flatMap((parent) =>
  fs
    .readdirSync(path.join(repoRoot, parent), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(repoRoot, parent, entry.name, "src")),
);
for (const root of sourceRoots) {
  for (const file of walk(root)) {
    const source = fs.readFileSync(file, "utf8");
    const matches = [];
    for (const match of source.matchAll(envAccess)) {
      matches.push({ name: match[1] ?? match[2], index: match.index });
    }
    for (const match of source.matchAll(helperCall)) {
      matches.push({ name: match[1], index: match.index });
    }
    for (const { name, index } of matches) {
      if (name.endsWith("_API_KEY") || registered.has(name)) continue;
      const line = source.slice(0, index).split("\n").length;
      findings.push(`${path.relative(repoRoot, file)}:${line}: ${name}`);
    }
  }
}

if (findings.length > 0) {
  console.error("Unregistered production env reads:");
  for (const finding of findings) console.error(`  ${finding}`);
  process.exit(1);
}
console.log("Production env reads are covered by the shared registry.");
