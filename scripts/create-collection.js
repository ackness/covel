#!/usr/bin/env node

/**
 * Scaffold a collection: one repository that ships a world together with the
 * plugins it needs.
 *
 *   node scripts/create-collection.js <collection-id> [target-dir]
 *
 * The result is a directory holding covel-collection.yaml, a README, and empty
 * plugins/ and worlds/ directories. Add packages with `pnpm create-plugin
 * <name> -t <dir>/plugins` and the create-world skill, list them in the
 * manifest, then run `pnpm validate:collection <dir>`.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const [id, targetArg] = process.argv.slice(2);

if (!id || !/^[a-z][a-z0-9-]{0,63}$/.test(id)) {
  console.error(
    "Usage: create-collection.js <collection-id> [target-dir]\nThe id uses lowercase letters, digits and hyphens.",
  );
  process.exit(1);
}

const target = resolve(targetArg ?? id);
if (existsSync(target)) {
  console.error(`Refusing to overwrite an existing path: ${target}`);
  process.exit(1);
}

const hostVersion = JSON.parse(
  readFileSync(join(ROOT, "package.json"), "utf-8"),
).version;

const manifest = `schemaVersion: 1
id: ${id}
name:
  en-US: ${id}
  zh-CN: ${id}
version: 0.1.0
# Covel versions this collection was written for. Comparators only:
# ">=X.Y.Z", optionally followed by "<A.B.C".
covel: ">=${hostVersion}"
# Packages in this repository are listed by path. A package in another
# repository is pinned by full commit SHA:
#   - repository: owner/repo
#     commit: 0123456789abcdef0123456789abcdef01234567
#     path: plugins/their-plugin
worlds: []
plugins: []
`;

const readme = `# ${id}

A Covel collection: worlds and the plugins they need, installed together.

## Install

In Covel, open Settings → Install & manage, paste this repository's URL, tick
what you want, and confirm once.

## Layout

- \`covel-collection.yaml\` lists what the collection installs.
- \`plugins/<id>/\` holds each plugin (\`PLUGIN.md\` and \`package.json\`).
- \`worlds/<id>/\` holds each world (\`world.yaml\` and \`WORLD.md\`).

A world states the capabilities it needs in \`pluginPolicy.requires\`, as
contract IDs such as \`action-check@1\`. Ship a plugin that provides each one,
or rely on a plugin bundled with Covel.

## Check

\`\`\`bash
pnpm validate:collection path/to/${id}
\`\`\`
`;

mkdirSync(join(target, "plugins"), { recursive: true });
mkdirSync(join(target, "worlds"), { recursive: true });
writeFileSync(join(target, "covel-collection.yaml"), manifest);
writeFileSync(join(target, "README.md"), readme);
writeFileSync(join(target, "plugins", ".gitkeep"), "");
writeFileSync(join(target, "worlds", ".gitkeep"), "");

console.log(`Created ${target}`);
console.log("Next:");
console.log(`  pnpm create-plugin <name> -t ${join(target, "plugins")}`);
console.log(`  add the packages to ${join(target, "covel-collection.yaml")}`);
console.log(`  pnpm validate:collection ${target}`);
