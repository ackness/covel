import fs from "node:fs/promises";
import path from "node:path";
import { rewriteContributes } from "@covel/plugin-loader";
import { extractDeclarations } from "./extract-declarations.js";
import type { CliOutput } from "./run-cli.js";

export const EXTRACT_HELP = `Usage:
  covel-test-runtime extract <plugin-dir> [--check] [--json]

Runs the plugin's entry code with your permissions. Use only for your own package.
Writes tools, actions, services, forms, wires and hooks to canonical PLUGIN.md.
Extensions and command metadata are reported, never rewritten.
Localized registration lists are reported, never changed; prompt translations are allowed.
  --check  Write nothing; report added/removed names. Exit 1 on drift, 0 in sync.
  --json   Print extracted declarations and drift as JSON.
  --help   Show this help.
Extraction errors exit 1; invalid arguments exit 2.
`;

export async function runExtractCli(
  argv: readonly string[],
  output: CliOutput,
): Promise<number> {
  let check = false;
  let json = false;
  let root: string | undefined;
  for (const arg of argv) {
    if (arg === "--help" || arg === "-h") {
      output.stdout.write(EXTRACT_HELP);
      return 0;
    }
    if (arg === "--check") check = true;
    else if (arg === "--json") json = true;
    else if (arg === "--") continue;
    else if (arg.startsWith("-"))
      throw new Error(`Unknown extract option: ${arg}`);
    else if (root) throw new Error("extract accepts one plugin directory");
    else root = arg;
  }
  if (!root) throw new Error("extract requires a plugin directory");
  try {
    const file = path.resolve(root, "PLUGIN.md");
    const original = await fs.readFile(file, "utf8");
    const extracted = await extractDeclarations(root);
    const result = rewriteContributes(original, extracted);
    if (!check && result.changed.length) {
      // Reparse with the strict YAML reader and verify the declarations before writing.
      if (rewriteContributes(result.text, extracted).changed.length)
        throw new Error(
          "Rewritten PLUGIN.md does not match extracted declarations",
        );
      await fs.writeFile(file, result.text);
    }
    if (json)
      output.stdout.write(
        `${JSON.stringify({ extracted, drift: result.drift }, null, 2)}\n`,
      );
    else {
      if (check) {
        for (const { key, added, removed } of result.drift) {
          output.stdout.write(`@@ contributes.${key} @@\n`);
          for (const name of removed) output.stdout.write(`- ${name}\n`);
          for (const name of added) output.stdout.write(`+ ${name}\n`);
          if (!added.length && !removed.length)
            output.stdout.write("~ order or declaration shape changed\n");
        }
      } else if (result.changed.length)
        output.stdout.write(
          `Updated PLUGIN.md: ${result.changed.join(", ")}\n`,
        );
      if (!result.changed.length)
        output.stdout.write("Declarations are in sync.\n");
      output.stdout.write(
        `Extensions (not rewritten): ${extracted.extensions.join(", ") || "none"}\n`,
      );
      output.stdout.write(
        `Commands (not rewritten): ${extracted.commands.map((command) => command.name).join(", ") || "none"}\n`,
      );
    }
    for (const variant of extracted.localizedContributes)
      output.stderr.write(
        `${variant}: registration declarations belong only in canonical PLUGIN.md; variant left unchanged.\n`,
      );
    return check && result.changed.length ? 1 : 0;
  } catch (error) {
    output.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n`,
    );
    return 1;
  }
}
