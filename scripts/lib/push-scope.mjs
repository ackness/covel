/**
 * Which test suites a push can break.
 *
 * The pre-push hook defaults to the static gate, adding docs tests for docs-only
 * pushes. `check:push` and `COVEL_PUSH_CHECK=affected` also select changed
 * packages and their dependents; source CI runs every suite. A package is
 * selected in two ways:
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
 * gate (`pnpm check`) or `pnpm e2e --list` covers them locally.
 * Full browser and extension execution remains required in source CI.
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

/** Documentation that no test reads, so it never adds documentation tests. */
const DOCS_NO_TEST_READS = ["docs/CHANGELOG.md", "docs/changelog.d/**"];

const ROOT = "$TURBO_ROOT$/";

function findClosingBrace(glob, openIndex) {
  let depth = 0;
  for (let i = openIndex; i < glob.length; i += 1) {
    if (glob[i] === "{") depth += 1;
    else if (glob[i] === "}") {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function splitTopLevelCommas(text) {
  const parts = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] === "{") depth += 1;
    else if (text[i] === "}") depth = Math.max(0, depth - 1);
    else if (text[i] === "," && depth === 0) {
      parts.push(text.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(text.slice(start));
  return parts;
}

// A Turbo input glob: `**` crosses directories, `*` does not, `{a,b}` is a
// choice (which may contain wildcards or nested choices).
function globToSource(glob) {
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
      const end = findClosingBrace(glob, index);
      if (end === -1) {
        source += escape(char);
        index += 1;
      } else {
        const choices = splitTopLevelCommas(glob.slice(index + 1, end));
        source += `(?:${choices.map(globToSource).join("|")})`;
        index = end + 1;
      }
    } else {
      source += escape(char);
      index += 1;
    }
  }
  return source;
}

function toRegExp(glob) {
  return new RegExp(`^${globToSource(glob)}$`);
}

function escape(text) {
  return text.replace(/[.+?^${}()|[\]\\*]/g, "\\$&");
}

export function matcher(globs) {
  const include = [];
  const exclude = [];
  for (const glob of globs) {
    if (glob.startsWith("!")) exclude.push(toRegExp(glob.slice(1)));
    else include.push(toRegExp(glob));
  }
  return (file) =>
    include.some((pattern) => pattern.test(file)) &&
    !exclude.some((pattern) => pattern.test(file));
}

function rootInputs(task) {
  return (task?.inputs ?? []).flatMap((input) => {
    if (input.startsWith(ROOT)) return [input.slice(ROOT.length)];
    if (input.startsWith(`!${ROOT}`))
      return [`!${input.slice(ROOT.length + 1)}`];
    return [];
  });
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

  const workspaceFiles = matcher(WORKSPACE_FILES);
  const globalDependencies = matcher(turbo.globalDependencies ?? []);
  const baseTestInputs = matcher(rootInputs(tasks.test));
  const everySuiteReads = (file) =>
    workspaceFiles(file) || globalDependencies(file) || baseTestInputs(file);
  const coveredWithoutTests = matcher(COVERED_WITHOUT_TESTS);
  const noTestReads = matcher(DOCS_NO_TEST_READS);
  // The suites that read files outside their package.
  const readers = packages
    .map(({ name }) => {
      const inputs = rootInputs(tasks[`${name}#test`]);
      return {
        name,
        hasPositive: inputs.some((input) => !input.startsWith("!")),
        reads: matcher(inputs),
      };
    })
    .filter(({ hasPositive }) => hasPositive);
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
