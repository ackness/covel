/** Statically validate current-format packages; never execute plugin entries. */
import fs from "node:fs/promises";
import path from "node:path";
import { loadPluginDefinition } from "../src/load.js";
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
      const runtimeDir = path.join(rootPath, "runtimes");
      const entries = await fs
        .readdir(runtimeDir, { withFileTypes: true })
        .catch((error: NodeJS.ErrnoException) => {
          if (error.code === "ENOENT") return [];
          throw error;
        });
      const pluginMdPaths: string[] = [];
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const dir = path.join(runtimeDir, entry.name);
        if (
          await fs.stat(path.join(dir, "PLUGIN.md")).then(
            () => true,
            () => false,
          )
        )
          throw new Error(`${dir}: rename child PLUGIN.md to RUNTIME.md`);
        pluginMdPaths.push(path.join(dir, "RUNTIME.md"));
      }
      const definition = await loadPluginDefinition({
        id: path.basename(rootPath),
        rootPath,
        isMultiRuntime: await fs.stat(runtimeDir).then(
          () => true,
          () => false,
        ),
        pluginMdPaths,
      });
      // The installer shows the version in package.json and the host uses the
      // one in PLUGIN.md. A package that states both must state one version.
      const declared = definition.packageManifest.plugin.version;
      const packaged = await fs
        .readFile(path.join(rootPath, "package.json"), "utf-8")
        .then(
          (content) => (JSON.parse(content) as { version?: unknown }).version,
          () => undefined,
        );
      if (declared && typeof packaged === "string" && declared !== packaged)
        throw new Error(
          `${rootPath}: PLUGIN.md version ${declared} differs from package.json version ${packaged}`,
        );
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
    } catch (error) {
      output.stderr.write(
        `✗ ${error instanceof Error ? error.message : String(error)}\n`,
      );
      status = 1;
    }
  }
  return status;
}
