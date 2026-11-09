import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { packageImports } from "./package-imports.mjs";

const SKIPPED = new Set(["node_modules", "dist", ".turbo", "coverage"]);
const SOURCE = /\.(?:[cm]?[jt]s|tsx)$/;
const DEPENDENCY_FIELDS = [
  "dependencies",
  "devDependencies",
  "optionalDependencies",
];
// `lint` type-checks imported files; `test` also reads files at run time.
const TASKS = ["lint", "test"];

function walk(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) =>
    SKIPPED.has(entry.name)
      ? []
      : entry.isDirectory()
        ? walk(path.join(directory, entry.name))
        : SOURCE.test(entry.name)
          ? [path.join(directory, entry.name)]
          : [],
  );
}

/** Every workspace package reachable through any dependency field. */
export function dependencyClosure(workspace, byName) {
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
  const ownerOf = (target) =>
    workspaces.find(
      (item) =>
        target === item.directory ||
        target.startsWith(`${item.directory}${path.sep}`),
    );
  for (const workspace of workspaces) {
    for (const file of walk(workspace.directory)) {
      const source = readFileSync(file, "utf8");
      const seen = new Map();
      const record = (specifier, typed) => {
        // Cut template literals at their first substitution.
        const literal = specifier.split("${")[0];
        const target = path.resolve(path.dirname(file), literal);
        const owner = ownerOf(target);
        if (!owner || owner === workspace) return;
        const key = `${owner.name}\0${target}`;
        const previous = seen.get(key);
        if (previous) previous.typed ||= typed;
        else {
          const reference = {
            file,
            workspace,
            owner,
            target,
            specifier,
            typed,
          };
          seen.set(key, reference);
          references.push(reference);
        }
      };
      let imports = [];
      try {
        imports = packageImports(file, source);
      } catch {
        // Unparsable files are other checks' concern; literals still count.
      }
      for (const { specifier } of imports)
        if (specifier.startsWith(".")) record(specifier, true);
      for (const match of source.matchAll(/["'`]((?:\.\.?\/)+[^"'`\n]*)["'`]/g))
        record(match[1], false);
    }
  }
  return references;
}

/** Turbo replaces the generic task with a `package#task` entry; no merge. */
export function resolveTask(turbo, workspace, task) {
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
    // A directory is read through whatever it holds: an input must either
    // match anything inside it or be written inside it.
    return directory
      ? path.matchesGlob(`${at}/any/file`, local) ||
          (!negated && staticPrefix(local).startsWith(`${at}/`))
      : path.matchesGlob(at, local);
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
