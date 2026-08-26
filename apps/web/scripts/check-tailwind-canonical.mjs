import path from "node:path";
import process from "node:process";

import { lint } from "tailwind-lint/dist/linter.cjs";

const cwd = process.cwd();

// tailwind-lint 0.12.1 treats ordinary TypeScript identifiers such as
// "block" and "sticky" as CSS classes. Its --fix path can then delete those
// identifiers, so this integration stays read-only and filters that noise.
const result = await lint({
  cwd,
  patterns: [],
  autoDiscover: true,
  fix: false,
  verbose: false,
});

const actionable = [];
let ignoredCssConflicts = 0;

for (const file of result.files) {
  for (const diagnostic of file.diagnostics) {
    if (diagnostic.code === "cssConflict") {
      ignoredCssConflicts += 1;
      continue;
    }

    if (
      diagnostic.severity === 1 ||
      diagnostic.code === "suggestCanonicalClasses"
    ) {
      actionable.push({ file: file.path, diagnostic });
    }
  }
}

if (actionable.length > 0) {
  for (const { file, diagnostic } of actionable) {
    const relativePath = path.relative(cwd, file);
    const line = diagnostic.range.start.line + 1;
    const column = diagnostic.range.start.character + 1;
    const code = diagnostic.code ? ` (${diagnostic.code})` : "";
    console.error(
      `${relativePath}:${line}:${column} ${diagnostic.message}${code}`,
    );
  }

  console.error(`Found ${actionable.length} actionable Tailwind diagnostics.`);
  process.exitCode = 1;
} else {
  const ignoredSuffix =
    ignoredCssConflicts > 0
      ? `; ignored ${ignoredCssConflicts} cssConflict false positives`
      : "";
  console.log(
    `Tailwind canonical check passed (${result.totalFilesProcessed} files${ignoredSuffix}).`,
  );
}
