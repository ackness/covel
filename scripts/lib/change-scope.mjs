/**
 * Which changes are documentation only.
 *
 * A change that touches nothing else cannot alter what a test executes, with
 * one exception: the tests that read documentation, which `pnpm test:docs`
 * runs. Such a change runs the static gate, which holds the documentation
 * checks, and those tests; everything else is skipped by the pre-push hook and
 * by CI.
 *
 * Markdown is not documentation by its extension: `PLUGIN.md`, `RUNTIME.md`,
 * `WORLD.md` and the files under `prompts/` are source that a loader reads.
 *
 * The patterns are GitHub path filters. `.github/workflows/ci.yml` lists them
 * under `paths-ignore` and `.github/workflows/docs.yml` under `paths`;
 * scripts/tests/change-scope.test.mjs keeps the three lists equal.
 */
export const DOCS_PATH_FILTERS = [
  "docs/**",
  "*.md",
  "**/README.md",
  "**/README.*.md",
  "**/AGENTS.md",
  "**/CLAUDE.md",
  ".claude/skills/**",
  ".assets/**",
  "LICENSE",
  ".github/ISSUE_TEMPLATE/**",
  ".github/PULL_REQUEST_TEMPLATE.md",
];

// As in a GitHub path filter: `**/` is any number of directories, none
// included, `**` crosses directories and `*` does not.
function toRegExp(filter) {
  let source = "";
  for (let index = 0; index < filter.length;) {
    if (filter.startsWith("**/", index)) {
      source += "(?:.*/)?";
      index += 3;
    } else if (filter.startsWith("**", index)) {
      source += ".*";
      index += 2;
    } else if (filter[index] === "*") {
      source += "[^/]*";
      index += 1;
    } else {
      source += filter[index].replace(/[.+?^${}()|[\]\\]/g, "\\$&");
      index += 1;
    }
  }
  return new RegExp(`^${source}$`);
}

const matchers = DOCS_PATH_FILTERS.map(toRegExp);

export function isDocsPath(file) {
  return matchers.some((matcher) => matcher.test(file));
}

/** True when there is a change and every changed file is documentation. */
export function isDocsOnly(files) {
  return files.length > 0 && files.every(isDocsPath);
}
