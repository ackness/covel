#!/usr/bin/env tsx
/**
 * Print what a world may contain for the plugins in this checkout: files,
 * data contracts with a ready descriptor entry and an example, and the plugin
 * catalogue. Authors and coding agents read this instead of a copied table.
 */

import path from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";
import {
  describeAuthoringSurface,
  validateAuthoringExamples,
  type AuthoringSurface,
} from "../apps/server/src/authoring/describe.js";
import { loadPluginCatalogue } from "../apps/server/src/world-data/validate-world-package.js";

const USAGE = `Usage: pnpm describe:authoring [--json] [--check] [--locale <tag>] [--plugins <dir>]...

  --json           Print the full surface as JSON.
  --check          Validate every plugin's authoring example against its schema.
  --locale <tag>   Language for titles and labels. Default: en-US.
  --plugins <dir>  Also scan this directory for plugin packages. The bundled
                   plugins/ directory is always scanned.`;

const repoRoot = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const pluginsDirs = [path.join(repoRoot, "plugins")];
let json = false;
let check = false;
let locale = "en-US";

const args = process.argv.slice(2);
for (let index = 0; index < args.length; index += 1) {
  const arg = args[index]!;
  if (arg === "--json") json = true;
  else if (arg === "--check") check = true;
  else if (arg === "--locale" || arg === "--plugins") {
    const value = args[(index += 1)];
    if (!value) {
      console.error(USAGE);
      process.exit(2);
    }
    if (arg === "--locale") locale = value;
    else pluginsDirs.push(path.resolve(value));
  } else {
    console.error(`Unknown argument: ${arg}\n\n${USAGE}`);
    process.exit(2);
  }
}

function indent(block: string, spaces = 4): string {
  const pad = " ".repeat(spaces);
  return block
    .trimEnd()
    .split("\n")
    .map((line) => `${pad}${line}`)
    .join("\n");
}

function yamlBlock(value: unknown): string {
  return indent(YAML.stringify(value, { lineWidth: 100 }));
}

function render(surface: AuthoringSurface): string {
  const lines: string[] = [
    `# World authoring surface (${surface.plugins.length} plugins scanned)`,
    "",
    "Validate a world with `pnpm validate:world <world-dir>`.",
    "",
    "## Files of a world package",
    "",
  ];
  for (const file of surface.files)
    lines.push(
      `- \`${file.path}\` — ${file.purpose}${file.reference ? ` Fields: ${file.reference}` : ""}`,
    );

  lines.push("", "## Built-in data destinations", "");
  for (const destination of surface.destinations)
    lines.push(
      `### ${destination.title}`,
      "",
      destination.description,
      "",
      `Put the file at \`${destination.source.entry.path}\`: it is imported without a descriptor. The same source in a descriptor:`,
      "",
      yamlBlock({ [destination.source.id]: destination.source.entry }),
      "",
    );

  lines.push("## World data contracts", "");
  for (const contract of surface.contracts) {
    lines.push(
      `### ${contract.title} — \`${contract.contract}\` (plugin \`${contract.pluginId}\`)`,
      "",
    );
    if (contract.description) lines.push(contract.description, "");
    if (contract.hint) lines.push(`How to write it: ${contract.hint}`, "");
    if (contract.source)
      lines.push(
        `Put the ${contract.source.entry.kind === "media" ? "files in" : "file at"} \`${contract.source.entry.path}\`: ${contract.source.entry.kind === "media" ? "they are" : "it is"} imported without a descriptor. The same source in a descriptor:`,
        "",
        yamlBlock({ [contract.source.id]: contract.source.entry }),
        "",
      );
    lines.push(
      `Record schema: \`plugins/${contract.pluginId}/${contract.schema.replace(/^\.\//, "")}\``,
      "",
    );
    if (contract.example !== undefined)
      lines.push(
        `Example${contract.source ? ` (\`${contract.source.entry.path}\`)` : ""}:`,
        "",
        contract.source?.entry.kind === "json"
          ? indent(JSON.stringify(contract.example, null, 2))
          : yamlBlock(contract.example),
        "",
      );
  }

  lines.push("## Plugins", "");
  for (const plugin of surface.plugins) {
    lines.push(
      `- \`${plugin.id}\` — ${plugin.displayName}: ${plugin.description}`,
    );
    if (plugin.provides.length > 0)
      lines.push(`  - provides: ${plugin.provides.join(", ")}`);
    if (plugin.requires.length > 0)
      lines.push(`  - requires: ${plugin.requires.join(", ")}`);
    for (const setting of plugin.settings)
      lines.push(
        `  - setting \`${setting.key}\` (${setting.type}${setting.default !== undefined ? `, default ${JSON.stringify(setting.default)}` : ""}): ${setting.label}`,
      );
  }
  return `${lines.join("\n")}\n`;
}

const catalogue = await loadPluginCatalogue(pluginsDirs);

if (check) {
  const issues = await validateAuthoringExamples(catalogue);
  for (const issue of issues)
    console.error(
      `✗ ${issue.pluginId} · contributes.data.${issue.namespace}.authoring\n    ${issue.message}`,
    );
  if (issues.length > 0) process.exit(1);
  console.log("Authoring examples match their schemas.");
} else {
  const surface = await describeAuthoringSurface(catalogue, { locale });
  process.stdout.write(
    json ? `${JSON.stringify(surface, null, 2)}\n` : render(surface),
  );
}
