#!/usr/bin/env tsx

/**
 * Pack a collection directory into one ZIP for offline import:
 * `pnpm pack:collection <collection-dir> [out.zip]`.
 *
 * The ZIP holds covel-collection.yaml at its top level plus every member the
 * manifest lists. A member pinned in another repository cannot be packed: an
 * offline import has no network to fetch it from.
 */

import { createWriteStream } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import yazl from "yazl";
import {
  COLLECTION_MANIFEST_FILE,
  collectionManifestSchema,
} from "@covel/shared";

// pnpm runs this from the server package; resolve arguments where the user is.
const base = process.env.INIT_CWD ?? process.cwd();
const [directoryArg, outArg] = process.argv.slice(2);
if (!directoryArg) {
  console.error("Usage: pack-collection.ts <collection-dir> [out.zip]");
  process.exit(2);
}
const directory = path.resolve(base, directoryArg);

const parsed = collectionManifestSchema.safeParse(
  parseYaml(
    await readFile(path.join(directory, COLLECTION_MANIFEST_FILE), "utf-8"),
  ),
);
if (!parsed.success) {
  for (const issue of parsed.error.issues)
    console.error(`✗ ${issue.path.join(".") || "(root)"}: ${issue.message}`);
  process.exit(1);
}
const manifest = parsed.data;

/** Package files only: no dependencies, VCS data, or local receipts. */
async function listFiles(root: string, relative = ""): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(path.join(root, relative), {
    withFileTypes: true,
  })) {
    if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
    const next = relative ? `${relative}/${entry.name}` : entry.name;
    if (entry.isDirectory()) files.push(...(await listFiles(root, next)));
    else if (entry.isFile()) files.push(next);
  }
  return files;
}

const archive = new yazl.ZipFile();
archive.addFile(
  path.join(directory, COLLECTION_MANIFEST_FILE),
  COLLECTION_MANIFEST_FILE,
);
let count = 1;
for (const member of [...manifest.plugins, ...manifest.worlds]) {
  if ("repository" in member) {
    console.error(
      `✗ ${member.repository} is pinned in another repository and cannot be packed for offline import`,
    );
    process.exit(1);
  }
  for (const file of await listFiles(path.join(directory, member.path))) {
    archive.addFile(
      path.join(directory, member.path, file),
      `${member.path}/${file}`,
    );
    count += 1;
  }
}

const output = path.resolve(
  base,
  outArg ??
    `${manifest.id}${manifest.version ? `-${manifest.version}` : ""}.zip`,
);
await new Promise<void>((resolve, reject) => {
  archive.outputStream
    .pipe(createWriteStream(output))
    .on("close", resolve)
    .on("error", reject);
  archive.end();
});
console.log(`✓ ${output} (${count} files)`);
