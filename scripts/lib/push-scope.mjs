/**
 * Which test suites a push can break.
 *
 * The pre-push hook runs the static gate on everything and the tests of the
 * packages the pushed commits changed, with the packages that depend on them;
 * CI runs every suite. A package is selected in two ways:
 *
 * - a changed file is inside it: the package and its dependents run
 *   (`--filter=...<name>`);
 * - a changed file matches a `$TURBO_ROOT$` input of its `test` task in
 *   turbo.json (a suite that reads `plugins/`, `worlds/`, `prompts/` …): that
 *   package runs alone.
 *
 * A changed file that any suite may read (the lockfile, turbo.json,
 * vitest.base.ts, a file outside every package that nothing below accounts
 * for) selects every suite.
 */
import { isDocsPath } from "./change-scope.mjs";

/** Root files that configure every package. */
const WORKSPACE_FILES = [
  "package.json",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  "turbo.json",
];

/**
 * Root paths that no test task reads unless turbo.json says so: the static
 * gate (`pnpm check`) or `pnpm e2e --list` covers them.
 */
const COVERED_WITHOUT_TESTS = [
  ".github/**",
  "scripts/**",
  "tests/e2e/**",
  "playwright.config.ts",
  ".oxlintrc.jsonc",
  ".fallowrc.jsonc",
  ".pre-commit-config.yaml",
  ".prettierignore",
  ".gitignore",
  ".gitattributes",
];

/** Documentation that no test reads, so it never adds `pnpm test:docs`. */
const DOCS_NO_TEST_READS = ["docs/CHANGELOG.md", "docs/changelog.d/**"];

const ROOT = "$TURBO_ROOT$/";

// A Turbo input glob: `**` crosses directories, `*` does not, `{a,b}` is a
// choice.
function toRegExp(glob) {
  let source = "";
  for (let index = 0; index < glob.length;) {
    const char = glob[index];
    if (glob.startsWith("**/", index)) {
      source += "(?:.*/)?";
      index += 3;
    } else if (glob.startsWith("**", index)) {
      source += ".*";
      index += 2;
    } else if (char === "*") {
      source += "[^/]*";
      index += 1;
    } else if (char === "{") {
      const end = glob.indexOf("}", index);
      const choices = glob.slice(index + 1, end).split(",");
      source += `(?:${choices.map(escape).join("|")})`;
      index = end + 1;
    } else {
      source += escape(char);
      index += 1;
    }
  }
  return new RegExp(`^${source}$`);
}

function escape(text) {
  return text.replace(/[.+?^${}()|[\]\\*]/g, "\\$&");
}

function matcher(globs) {
  const patterns = globs.map(toRegExp);
  return (file) => patterns.some((pattern) => pattern.test(file));
}

function rootInputs(task) {
  return (task?.inputs ?? [])
    .filter((input) => input.startsWith(ROOT))
    .map((input) => input.slice(ROOT.length));
}

/**
 * @param {object} options
 * @param {string[]} options.files Changed paths, relative to the repository root.
 * @param {{ dir: string, name: string }[]} options.packages Workspace packages.
 * @param {object} options.turbo The parsed turbo.json of the pushed commit.
 * @returns {{ full: true, reason: string }
 *   | { full: false, filters: string[], docs: boolean }} Every suite, or the
 *   Turbo filters to run (none when no suite can be affected) and whether the
 *   tests that read documentation must run.
 */
export function selectTests({ files, packages, turbo }) {
  if (files.length === 0) return { full: true, reason: "no changed file" };
  const tasks = turbo?.tasks;
  if (!tasks || packages.length === 0) {
    return { full: true, reason: "the workspace could not be read" };
  }

  const everySuiteReads = matcher([
    ...WORKSPACE_FILES,
    ...(turbo.globalDependencies ?? []),
    ...rootInputs(tasks.test),
  ]);
  const coveredWithoutTests = matcher(COVERED_WITHOUT_TESTS);
  const noTestReads = matcher(DOCS_NO_TEST_READS);
  // The suites that read files outside their package.
  const readers = packages
    .map(({ name }) => ({
      name,
      reads: matcher(rootInputs(tasks[`${name}#test`])),
    }))
    .filter(({ name }) => rootInputs(tasks[`${name}#test`]).length > 0);
  // The longest directory wins, so a nested package owns its files.
  const byDepth = [...packages].sort((a, b) => b.dir.length - a.dir.length);

  const withDependents = new Set();
  const alone = new Set();
  let docs = false;
  for (const file of files) {
    if (everySuiteReads(file)) {
      return { full: true, reason: `${file} configures every package` };
    }
    let accounted = false;
    for (const reader of readers) {
      if (reader.reads(file)) {
        alone.add(reader.name);
        accounted = true;
      }
    }
    if (isDocsPath(file)) {
      if (!noTestReads(file)) docs = true;
      continue;
    }
    const owner = byDepth.find(({ dir }) => file.startsWith(`${dir}/`));
    if (owner) {
      withDependents.add(owner.name);
    } else if (!accounted && !coveredWithoutTests(file)) {
      return {
        full: true,
        reason: `${file} is outside every package and no rule says which suites read it`,
      };
    }
  }

  const filters = [
    ...[...withDependents].sort().map((name) => `...${name}`),
    ...[...alone].filter((name) => !withDependents.has(name)).sort(),
  ];
  return { full: false, filters, docs };
}
