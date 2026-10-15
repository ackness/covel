import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { packageImports } from "./package-imports.mjs";

/** Source includes tests and scaffolds, but never generated or retired code. */
export function sourceFiles(directory) {
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    if (
      entry.name.startsWith(".") ||
      ["node_modules", "dist", "build", "coverage", "_archive"].includes(
        entry.name,
      )
    )
      return [];
    const file = path.join(directory, entry.name);
    return entry.isDirectory()
      ? sourceFiles(file)
      : /\.(?:[cm]?[jt]s|[jt]sx)$/.test(file)
        ? [file]
        : [];
  });
}

export function unusedPackageExports(root, workspaces, allowlist = {}) {
  const consumers = new Map();
  for (const group of [
    "apps",
    "packages",
    "plugins",
    "templates",
    "scripts",
    "tests",
  ]) {
    for (const file of sourceFiles(path.join(root, group))) {
      for (const { specifier } of packageImports(
        file,
        readFileSync(file, "utf8"),
      )) {
        if (!consumers.has(specifier)) consumers.set(specifier, new Set());
        consumers.get(specifier).add(file);
      }
    }
  }
  const errors = [];
  const entries = new Set();
  for (const workspace of workspaces.filter(
    (item) => item.group === "packages",
  )) {
    const exports = workspace.manifest.exports;
    if (!exports) continue;
    const subpaths =
      typeof exports === "object" &&
      Object.keys(exports).some((key) => key.startsWith("."))
        ? Object.keys(exports)
        : ["."];
    for (const subpath of subpaths) {
      const specifier =
        workspace.manifest.name + (subpath === "." ? "" : subpath.slice(1));
      entries.add(specifier);
      const pattern = new RegExp(
        `^${specifier
          .split("*")
          .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
          .join(".*")}$`,
      );
      const used = [...consumers].some(
        ([name, files]) =>
          pattern.test(name) &&
          [...files].some(
            (file) => !file.startsWith(`${workspace.directory}${path.sep}`),
          ),
      );
      if (!used && !allowlist[specifier]?.trim()) {
        errors.push(
          `${path.relative(root, workspace.directory)}/package.json: ${specifier}: export has no importer outside its package; remove it or allowlist it with a reason`,
        );
      }
    }
  }
  for (const [specifier, reason] of Object.entries(allowlist)) {
    if (!entries.has(specifier) || !reason.trim())
      errors.push(
        `${specifier}: export allowlist entry must name an existing export and give a reason`,
      );
  }
  return errors;
}
