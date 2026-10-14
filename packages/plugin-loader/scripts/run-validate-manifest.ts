import { readFileSync } from "node:fs";
import {
  packageModuleTypeProblem,
  validatePluginFiles,
} from "../src/static-validation.js";
/** Statically validate current-format packages; never execute plugin entries. */
import fs from "node:fs/promises";
import path from "node:path";
import { loadPluginDefinition } from "../src/load.js";
import { discoverPluginAt } from "../src/discover.js";
import { validatePluginLabels } from "../src/locale-labels.js";
import { describePluginLanguages } from "../src/plugin-languages.js";

/** Where a validation run writes its results and its messages. */
export interface ValidateManifestOutput {
  stdout: { write(text: string): unknown };
  stderr: { write(text: string): unknown };
}

/**
 * Validates the package of each path and returns the exit code: 0 when every
 * package passes, 1 when one fails, 2 when the arguments are not paths.
 */
export async function runValidateManifest(
  args: readonly string[],
  output: ValidateManifestOutput = process,
): Promise<number> {
  if (!args.length || args.some((arg) => arg.startsWith("--"))) {
    output.stderr.write(
      "Usage: pnpm validate:plugin <PLUGIN.md | RUNTIME.md | plugin-dir>...\n",
    );
    return 2;
  }
  let status = 0;
  const visited = new Set<string>();
  for (const arg of args) {
    try {
      let rootPath = path.resolve(arg);
      if ((await fs.stat(rootPath)).isFile()) rootPath = path.dirname(rootPath);
      if (path.basename(path.dirname(rootPath)) === "runtimes")
        rootPath = path.dirname(path.dirname(rootPath));
      rootPath = await fs.realpath(rootPath);
      if (visited.has(rootPath)) continue;
      visited.add(rootPath);
      const discovery = await discoverPluginAt(rootPath);
      if (!discovery)
        throw new Error(
          `${rootPath}: no enabled plugin with a root PLUGIN.md found`,
        );
      if (discovery.layoutWarnings?.length)
        throw new Error(discovery.layoutWarnings.join("\n"));
      const definition = await loadPluginDefinition(discovery);
      validatePluginFiles(
        definition.packageManifest,
        definition.manifests,
        (file) => readFileSync(file, "utf8"),
      );
      // The installer shows the version in package.json and the host uses the
      // one in PLUGIN.md. A package that states both must state one version.
      const declared = definition.packageManifest.plugin.version;
      const packageJson = await fs
        .readFile(path.join(rootPath, "package.json"), "utf-8")
        .then(
          (content) =>
            JSON.parse(content) as { version?: unknown; type?: unknown },
          () => undefined,
        );
      const packaged = packageJson?.version;
      if (declared && typeof packaged === "string" && declared !== packaged)
        throw new Error(
          `${rootPath}: PLUGIN.md version ${declared} differs from package.json version ${packaged}`,
        );
      const moduleProblem =
        packageJson && packageModuleTypeProblem(packageJson);
      if (moduleProblem) throw new Error(`${rootPath}: ${moduleProblem}`);
      const labelProblems = await validatePluginLabels(rootPath);
      if (labelProblems.length > 0)
        throw new Error(
          `${rootPath}: locale files\n  - ${labelProblems.join("\n  - ")}`,
        );
      output.stdout.write(`✓ Static package validation: ${rootPath}\n`);
      // A language the package lacks is not an error: labels fall back to
      // English and the prompts are English. The author sees what players get.
      output.stdout.write(
        `  languages: ${describePluginLanguages(definition.languages)}\n`,
      );
      // A plugin names the role (slot) it wants; the player's settings pick
      // the model and the endpoint. Nothing reads a plugin's own llm.toml.
      if (
        await fs.stat(path.join(rootPath, "llm.toml")).then(
          () => true,
          () => false,
        )
      )
        output.stdout.write(
          "  warning: llm.toml is ignored: a plugin cannot choose a model or an endpoint. Name the role with agent.model / function.model; the player's model settings bind it.\n",
        );
    } catch (error) {
      output.stderr.write(
        `✗ ${error instanceof Error ? error.message : String(error)}\n`,
      );
      status = 1;
    }
  }
  return status;
}
