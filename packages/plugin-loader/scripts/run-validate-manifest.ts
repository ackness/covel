import {
  normalizePluginPackagePath,
  validatePluginPackage,
} from "../src/package-validation.js";

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
      const rootPath = await normalizePluginPackagePath(arg);
      if (visited.has(rootPath)) continue;
      visited.add(rootPath);
      const report = await validatePluginPackage(rootPath);
      if (!report.ok) {
        output.stderr.write(`✗ ${report.cliFailure}\n`);
        status = 1;
      } else {
        output.stdout.write(
          `✓ Static package validation: ${report.rootPath}\n`,
        );
        output.stdout.write(`  languages: ${report.languages}\n`);
        for (const warning of report.cliWarnings)
          output.stdout.write(`${warning}\n`);
      }
    } catch (error) {
      output.stderr.write(
        `✗ ${error instanceof Error ? error.message : String(error)}\n`,
      );
      status = 1;
    }
  }
  return status;
}
