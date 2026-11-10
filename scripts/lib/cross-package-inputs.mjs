import { readFileSync, statSync } from "node:fs";
import path from "node:path";
import { packageImports } from "./package-imports.mjs";
import { sourceFiles, workspaceOf } from "./package-exports.mjs";
import { matcher } from "./push-scope.mjs";

const DEPENDENCY_FIELDS = [
  "dependencies",
  "devDependencies",
  "optionalDependencies",
];
// `lint` type-checks imported files; `test` also reads files at run time.
const TASKS = ["lint", "test"];
// A relative path inside a string literal or module specifier.
const RELATIVE_LITERAL = /["'`]((?:\.\.?\/)+[^"'`\n]*)["'`]/g;

/** Every workspace package reachable through any dependency field. */
function dependencyClosure(workspace, byName) {
  const seen = new Set();
  const pending = [workspace];
  while (pending.length) {
    const current = pending.pop();
    for (const field of DEPENDENCY_FIELDS)
      for (const name of Object.keys(current.manifest[field] ?? {})) {
        const dependency = byName.get(name);
        if (dependency && !seen.has(dependency)) {
          seen.add(dependency);
          pending.push(dependency);
        }
      }
  }
  return seen;
}

/**
 * Files in another workspace that a source file loads by relative path:
 * module specifiers (type-checked by `lint`, executed by `test`) and string
 * literals such as `new URL("../../plugins/x", import.meta.url)` (`test` only).
 * Paths assembled from several literals are not seen.
 */
export function crossWorkspaceReferences(workspaces) {
  const references = [];
  for (const workspace of workspaces) {
    for (const file of sourceFiles(workspace.directory)) {
      const source = readFileSync(file, "utf8");
      const seen = new Map();
      for (const match of source.matchAll(RELATIVE_LITERAL)) {
        const specifier = match[1];
        // Cut template literals at their first substitution.
        const target = path.resolve(
          path.dirname(file),
          specifier.split("${")[0],
        );
        const owner = workspaceOf(workspaces, target);
        if (!owner || owner === workspace) continue;
        if (!seen.has(target))
          seen.set(target, { file, workspace, owner, target, specifier });
      }
      if (!seen.size) continue;
      // A module specifier is type-checked by `lint`; a bare literal is not.
      const imported = importedTargets(file, source);
      for (const reference of seen.values())
        references.push({
          ...reference,
          typed: imported.has(reference.target),
        });
    }
  }
  return references;
}

function importedTargets(file, source) {
  try {
    return new Set(
      packageImports(file, source)
        .filter(({ specifier }) => specifier.startsWith("."))
        .map(({ specifier }) => path.resolve(path.dirname(file), specifier)),
    );
  } catch {
    // Unparsable files are other checks' concern; literals still count.
    return new Set();
  }
}

/** Turbo replaces the generic task with a `package#task` entry; no merge. */
function resolveTask(turbo, workspace, task) {
  return (
    turbo.tasks?.[`${workspace.manifest.name}#${task}`] ?? turbo.tasks?.[task]
  );
}

/** The literal directory a glob starts in: `apps/web/src/*.css` -> `apps/web/src/`. */
function staticPrefix(pattern) {
  const literal = pattern.split(/[*?{[]/)[0];
  return literal.slice(0, literal.lastIndexOf("/") + 1);
}

function declaresInput(root, workspace, definition, target) {
  const directory = statSync(target, { throwIfNoEntry: false })?.isDirectory();
  const relative = (base) =>
    path.relative(base, target).split(path.sep).join("/");
  const matches = (glob) => {
    const negated = glob.startsWith("!");
    const pattern = glob.replace(/^!/, "");
    const rooted = pattern.startsWith("$TURBO_ROOT$/");
    const base = rooted ? root : workspace.directory;
    const local = rooted ? pattern.slice("$TURBO_ROOT$/".length) : pattern;
    const at = relative(base);
    if (!directory) return matcher([local])(at);
    // Directory reads include future descendants, so only a recursive glob
    // covering the directory itself can cover the entire read.
    if (!negated)
      return (
        (local === "**" || local.endsWith("/**")) && matcher([local])(`${at}/`)
      );
    // An exclusion that may overlap any descendant leaves part of the read
    // unhashed. Be conservative when its wildcard suffix cannot prove disjointness.
    const prefix = staticPrefix(local);
    return prefix.startsWith(`${at}/`) || `${at}/`.startsWith(prefix);
  };
  const globs = (definition?.inputs ?? []).filter(
    (glob) => glob !== "$TURBO_DEFAULT$",
  );
  return (
    globs.some((glob) => !glob.startsWith("!") && matches(glob)) &&
    !globs.some((glob) => glob.startsWith("!") && matches(glob))
  );
}

/**
 * A task re-runs when another workspace's file changes only if that workspace
 * is a dependency hashed through `^build`, or if the task lists the file as an
 * input. Anything else lets Turbo replay a cached pass over stale code.
 */
export function uncachedReferences({ root, turbo, workspaces, references }) {
  const byName = new Map(workspaces.map((item) => [item.manifest.name, item]));
  const closures = new Map(
    workspaces.map((item) => [item, dependencyClosure(item, byName)]),
  );
  const problems = [];
  for (const reference of references) {
    const tasks = TASKS.filter(
      (task) =>
        (task === "test" || reference.typed) &&
        reference.workspace.manifest.scripts?.[task],
    );
    const missing = tasks.filter((task) => {
      const definition = resolveTask(turbo, reference.workspace, task);
      // An uncached task runs on every invocation.
      if (definition?.cache === false) return false;
      const hashed =
        definition?.dependsOn?.includes("^build") &&
        closures.get(reference.workspace).has(reference.owner);
      return (
        !hashed &&
        !declaresInput(root, reference.workspace, definition, reference.target)
      );
    });
    if (missing.length) problems.push({ ...reference, missing });
  }
  return problems;
}
