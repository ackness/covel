import path from "node:path";

const TEST_DIRECTORIES = new Set(["tests", "__tests__", "fixtures"]);

/** The files `check-package-boundaries` treats as production source. */
export function isProductionFile(workspace, file) {
  const relative = path.relative(workspace.directory, file);
  const segments = relative.split(path.sep);
  if (workspace.group !== "plugins" && segments[0] !== "src") return false;
  return (
    !segments.slice(0, -1).some((segment) => TEST_DIRECTORIES.has(segment)) &&
    !/\.(?:test|spec)\./.test(path.basename(file))
  );
}

const posix = (root, file) =>
  path.relative(root, file).split(path.sep).join("/");

/**
 * Tests, fixtures, configs and scripts of a workspace must reach another
 * `apps/*` or `packages/*` workspace through its package entries (`.` or a
 * subpath such as `./testing`), never by a relative path into its files.
 * Relative imports and `vi.mock()` paths both count. `references` comes from
 * `crossWorkspaceReferences`, so production source (checked by the boundary
 * scan) and bare string literals are skipped here.
 *
 * Bundled plugins are exempt as targets: they publish no package entries, the
 * plugin loader reads their files by path, and tests load those modules as
 * fixtures.
 *
 * `allowlist` lists the remaining exceptions as
 * `{ from, imports: [target, ...], reason }`, with paths relative to `root`
 * and each target spelled as its specifier resolves. Every pair must still
 * occur, so a stale exception fails as well.
 */
export function testSourceImportErrors(root, references, allowlist = []) {
  const errors = [];
  const allowed = new Map();
  for (const entry of allowlist) {
    if (!entry.reason?.trim() || !entry.imports?.length)
      errors.push(
        `${entry.from}: test import allowlist entry needs imports and a reason`,
      );
    for (const target of entry.imports ?? [])
      allowed.set(`${entry.from}\0${target}`, false);
  }
  for (const reference of references) {
    const { file, workspace, owner, target, specifier, typed, mocked } =
      reference;
    if (!typed && !mocked) continue;
    if (owner.group === "plugins" || isProductionFile(workspace, file))
      continue;
    const key = `${posix(root, file)}\0${posix(root, target)}`;
    if (allowed.has(key)) {
      allowed.set(key, true);
      continue;
    }
    errors.push(
      `${posix(root, file)}: ${specifier}: ${mocked ? "mocks" : "imports"} a file of ${owner.manifest.name} by relative path; use its public or ./testing entry`,
    );
  }
  for (const [key, used] of allowed)
    if (!used)
      errors.push(
        `${key.replace("\0", ": ")}: stale test import allowlist entry; remove it`,
      );
  return errors;
}
