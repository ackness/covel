#!/usr/bin/env tsx

/**
 * Static check of a collection directory: `pnpm validate:collection <dir>`.
 *
 * It runs the same completeness check the installer runs for a preview, against
 * the plugins bundled in this repository, so an author sees in CI what a
 * player would see before installing. Members pinned in other repositories are
 * not downloaded; they are listed so the author knows the result is partial.
 */

import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import YAML from "yaml";
import {
  COLLECTION_MANIFEST_FILE,
  checkCollection,
  collectionManifestSchema,
  collectionPluginFacts,
  collectionWorldFacts,
  validateWorldManifest,
  type CollectionPluginFacts,
  type CollectionProblem,
  type CollectionWorldFacts,
} from "@covel/shared";

const REPO_ROOT = path.resolve(import.meta.dirname, "..");

const [directory] = process.argv.slice(2);
if (!directory) {
  console.error("Usage: validate-collection.ts <collection-dir>");
  process.exit(2);
}

/** Plain YAML frontmatter only, as the installer accepts it. */
async function readPluginManifest(pluginDir: string) {
  const text = await readFile(path.join(pluginDir, "PLUGIN.md"), "utf-8");
  const match = /^﻿?---[ \t]*\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text);
  if (!match) throw new Error("PLUGIN.md requires plain YAML frontmatter");
  return YAML.parse(match[1]!) as Record<string, unknown>;
}

async function bundledPlugins(): Promise<CollectionPluginFacts[]> {
  const root = path.join(REPO_ROOT, "plugins");
  const facts: CollectionPluginFacts[] = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith("_")) continue;
    try {
      facts.push(
        collectionPluginFacts(
          await readPluginManifest(path.join(root, entry.name)),
        ),
      );
    } catch {
      // A directory without a readable manifest is not a bundled plugin.
    }
  }
  return facts;
}

const problems: CollectionProblem[] = [];
const notes: string[] = [];
const fail = (message: string, packageId?: string) =>
  problems.push({
    level: "error",
    message,
    ...(packageId ? { packageId } : {}),
  });

let raw: unknown;
try {
  raw = YAML.parse(
    await readFile(path.join(directory, COLLECTION_MANIFEST_FILE), "utf-8"),
  );
} catch (error) {
  console.error(
    `✗ ${path.join(directory, COLLECTION_MANIFEST_FILE)}: ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exit(1);
}
const parsed = collectionManifestSchema.safeParse(raw);
if (!parsed.success) {
  for (const issue of parsed.error.issues)
    console.error(`✗ ${issue.path.join(".") || "(root)"}: ${issue.message}`);
  process.exit(1);
}
const manifest = parsed.data;

const plugins: CollectionPluginFacts[] = [];
for (const member of manifest.plugins) {
  if ("repository" in member) {
    notes.push(
      `plugin ${member.repository}@${member.commit.slice(0, 7)}${member.path ? `:${member.path}` : ""} is pinned elsewhere and was not read`,
    );
    continue;
  }
  const pluginDir = path.join(directory, member.path);
  try {
    await readFile(path.join(pluginDir, "package.json"), "utf-8");
    plugins.push(collectionPluginFacts(await readPluginManifest(pluginDir)));
  } catch (error) {
    fail(
      `${member.path}: not an installable plugin (${error instanceof Error ? error.message : String(error)})`,
    );
  }
}

const worlds: CollectionWorldFacts[] = [];
for (const member of manifest.worlds) {
  if ("repository" in member) {
    notes.push(
      `world ${member.repository}@${member.commit.slice(0, 7)}${member.path ? `:${member.path}` : ""} is pinned elsewhere and was not read`,
    );
    continue;
  }
  try {
    const world = YAML.parse(
      await readFile(path.join(directory, member.path, "world.yaml"), "utf-8"),
    ) as Record<string, unknown>;
    const validation = validateWorldManifest(world);
    if (!validation.valid) {
      fail(`${member.path}/world.yaml does not match the world schema`);
      continue;
    }
    worlds.push(collectionWorldFacts(world));
  } catch (error) {
    fail(
      `${member.path}: not a world package (${error instanceof Error ? error.message : String(error)})`,
    );
  }
}

const hostVersion = (
  JSON.parse(await readFile(path.join(REPO_ROOT, "package.json"), "utf-8")) as {
    version: string;
  }
).version;
problems.push(
  ...checkCollection({
    worlds,
    plugins,
    available: await bundledPlugins(),
    hostVersion,
    collectionRange: manifest.covel,
  }),
);

for (const note of notes) console.log(`• ${note}`);
for (const problem of problems)
  console[problem.level === "error" ? "error" : "warn"](
    `${problem.level === "error" ? "✗" : "!"} ${problem.message}`,
  );
const errors = problems.filter((problem) => problem.level === "error").length;
if (errors > 0) {
  console.error(`✗ ${manifest.id}: ${errors} error(s)`);
  process.exit(1);
}
console.log(
  `✓ ${manifest.id}: ${plugins.length} plugin(s), ${worlds.length} world(s) checked against Covel ${hostVersion}`,
);
