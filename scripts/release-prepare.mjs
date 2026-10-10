/**
 * Prepare the files of a release: the framework version in the root, apps/* and
 * packages/* manifests, the README version badges, and the changelog assembly.
 *
 *   node scripts/release-prepare.mjs <version> [--dry-run] [--date YYYY-MM-DD]
 *
 * It refuses a version below the current one and a dirty working tree, and
 * makes no commit, tag or push. A second run with the same version only adds
 * changelog fragments merged since. The checklist is in
 * docs/guide/desktop-packaging.md.
 */
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { prepareRelease } from "./lib/release-prepare.mjs";

function today() {
  const now = new Date();
  const pad = (value) => String(value).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

function main(argv) {
  const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
  const dryRun = argv.includes("--dry-run");
  const dateFlag = argv.indexOf("--date");
  const date = dateFlag === -1 ? today() : argv[dateFlag + 1];
  const version = argv
    .find((value, index) => !value.startsWith("--") && index !== dateFlag + 1)
    ?.replace(/^v/, "");
  if (!version) {
    console.error(
      "Usage: node scripts/release-prepare.mjs <version> [--dry-run] [--date YYYY-MM-DD]",
    );
    return 1;
  }
  const { changes, notes } = prepareRelease(root, {
    version,
    date,
    dryRun,
    isClean: () =>
      execFileSync("git", ["status", "--porcelain"], {
        cwd: root,
        encoding: "utf8",
      }).trim() === "",
  });
  console.log(
    `${dryRun ? "Would change" : "Changed"} for v${version} (${date}):`,
  );
  if (changes.length === 0) console.log("  nothing; already prepared.");
  for (const change of changes) console.log(`  ${change}`);
  for (const note of notes) console.log(`\n${note}`);
  return 0;
}

try {
  process.exitCode = main(process.argv.slice(2));
} catch (error) {
  console.error(`✗ ${error.message}`);
  process.exitCode = 1;
}
