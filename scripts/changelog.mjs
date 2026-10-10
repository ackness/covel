/**
 * Changelog fragments: check, preview, release.
 *
 *   node scripts/changelog.mjs check               every fragment parses
 *   node scripts/changelog.mjs check --no-pending  and nothing waits for a release
 *   node scripts/changelog.mjs preview             print [Unreleased] with the fragments
 *   node scripts/changelog.mjs release <version> [--date YYYY-MM-DD]
 *
 * The format is described in docs/changelog.d/README.md. This file uses Node
 * built-ins only: the release workflow runs it before dependencies are
 * installed.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  CHANGELOG_PATH,
  FRAGMENT_DIR,
  assembleRelease,
  isFragmentName,
  pendingEntries,
  renderPreview,
  unreleasedEntriesError,
} from "./lib/changelog-fragments.mjs";

/** The fragment files of a checkout, and the other files in their directory. */
export function readFragments(root) {
  const directory = path.join(root, FRAGMENT_DIR);
  const fragments = [];
  const strays = [];
  if (!fs.existsSync(directory)) return { fragments, strays };
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (entry.isFile() && isFragmentName(entry.name)) {
      fragments.push({
        name: entry.name,
        text: fs.readFileSync(path.join(directory, entry.name), "utf8"),
      });
    } else if (entry.name !== "README.md") {
      strays.push(entry.name);
    }
  }
  return { fragments, strays };
}

/** The reasons the fragments of a checkout are not valid. */
export function checkChangelog(root, { noPending = false } = {}) {
  const changelog = fs.readFileSync(path.join(root, CHANGELOG_PATH), "utf8");
  const { fragments, strays } = readFragments(root);
  const pending = pendingEntries(changelog, fragments);
  const errors = [...pending.errors];
  for (const name of strays) {
    errors.push(
      `${FRAGMENT_DIR}/${name}: only fragment files (<slug>.md) and README.md belong here`,
    );
  }
  if (noPending && fragments.length + pending.legacy > 0) {
    errors.push(
      `${fragments.length} changelog fragment(s) and ${pending.legacy} [Unreleased] entries are not in a release; run "pnpm changelog:release <version>" and commit the result.`,
    );
  } else if (pending.legacy > 0 && !pending.legacyAllowed) {
    errors.push(unreleasedEntriesError(pending.legacy));
  }
  return { errors, fragments: fragments.length, legacy: pending.legacy };
}

function today() {
  const now = new Date();
  const pad = (value) => String(value).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

function main(argv) {
  const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
  const [command, ...rest] = argv;
  if (command === "check") {
    const result = checkChangelog(root, {
      noPending: rest.includes("--no-pending"),
    });
    if (result.errors.length > 0) {
      for (const error of result.errors) console.error(`✗ ${error}`);
      return 1;
    }
    console.log(
      `Changelog fragments: ${result.fragments} valid` +
        (result.legacy > 0
          ? `; ${result.legacy} earlier entries under [Unreleased]`
          : ""),
    );
    return 0;
  }
  const changelogFile = path.join(root, CHANGELOG_PATH);
  const changelog = fs.readFileSync(changelogFile, "utf8");
  const { fragments } = readFragments(root);
  if (command === "preview") {
    const pending = pendingEntries(changelog, fragments);
    for (const error of pending.errors) console.error(`✗ ${error}`);
    process.stdout.write(renderPreview(changelog, fragments));
    return pending.errors.length > 0 ? 1 : 0;
  }
  if (command === "release") {
    const dateFlag = rest.indexOf("--date");
    const date = dateFlag === -1 ? today() : rest[dateFlag + 1];
    const version = rest
      .find(
        (value, index) =>
          !value.startsWith("--") &&
          (dateFlag === -1 || index !== dateFlag + 1),
      )
      ?.replace(/^v/, "");
    const { text, moved } = assembleRelease(changelog, fragments, {
      version,
      date,
    });
    if (text !== changelog) fs.writeFileSync(changelogFile, text);
    for (const { name } of fragments) {
      fs.rmSync(path.join(root, FRAGMENT_DIR, name));
    }
    console.log(
      moved === 0
        ? `[${version}] is already assembled; nothing changed.`
        : `Moved ${moved} entries to [${version}] in ${CHANGELOG_PATH} and removed ${fragments.length} fragment(s). Write the release summary under the heading.`,
    );
    return 0;
  }
  console.error(
    "Usage: node scripts/changelog.mjs check [--no-pending] | preview | release <version> [--date YYYY-MM-DD]",
  );
  return 1;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (error) {
    console.error(`✗ ${error.message}`);
    process.exitCode = 1;
  }
}
