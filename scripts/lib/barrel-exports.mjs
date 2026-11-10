import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseSync } from "oxc-parser";

/**
 * The root entry of `@covel/shared` is frozen: it may lose exports but never
 * gain one. New code goes into a domain subpath entry instead.
 */
export const sharedBarrel = {
  entry: "packages/shared/src/index.ts",
  baseline: "packages/shared/root-exports.baseline.txt",
  manifest: "packages/shared/package.json",
};

function bindingNames(pattern) {
  if (!pattern) return [];
  switch (pattern.type) {
    case "Identifier":
      return [pattern.name];
    case "ObjectPattern":
      return pattern.properties.flatMap((property) =>
        bindingNames(
          property.type === "RestElement" ? property.argument : property.value,
        ),
      );
    case "ArrayPattern":
      return pattern.elements.flatMap(bindingNames);
    case "AssignmentPattern":
      return bindingNames(pattern.left);
    case "RestElement":
      return bindingNames(pattern.argument);
    default:
      return [];
  }
}

function declarationNames(declaration) {
  if (declaration.type === "VariableDeclaration")
    return declaration.declarations.flatMap((item) => bindingNames(item.id));
  // `declare global` and ambient string modules do not add a named export.
  if (declaration.type === "TSModuleDeclaration")
    return declaration.id?.type === "Identifier" ? [declaration.id.name] : [];
  return declaration.id?.name ? [declaration.id.name] : [];
}

function moduleName(node) {
  return node.name ?? node.value;
}

function resolveRelative(from, specifier) {
  const base = path.resolve(path.dirname(from), specifier);
  const stem = base.replace(/\.[cm]?js$/, "");
  for (const candidate of [
    `${stem}.ts`,
    `${stem}.tsx`,
    path.join(base, "index.ts"),
    base,
  ])
    if (existsSync(candidate) && /\.[cm]?tsx?$/.test(candidate))
      return candidate;
  throw new Error(`${from}: cannot resolve ${specifier}`);
}

/**
 * Names a module exports, read from syntax. `export *` from a relative module
 * is expanded, so adding a name to a re-exported module counts as a new export.
 * `export *` from a package stays one `* from <specifier>` entry.
 */
export function exportedNames(file, seen = new Set()) {
  const names = new Set();
  if (seen.has(file)) return names;
  seen.add(file);
  const parsed = parseSync(file, readFileSync(file, "utf8"));
  if (parsed.errors.length)
    throw new Error(`${file}: ${parsed.errors[0].message}`);
  for (const node of parsed.program.body) {
    if (node.type === "ExportNamedDeclaration") {
      if (node.declaration)
        for (const name of declarationNames(node.declaration)) names.add(name);
      for (const specifier of node.specifiers)
        names.add(moduleName(specifier.exported));
    } else if (node.type === "ExportAllDeclaration") {
      const source = node.source.value;
      if (node.exported) names.add(moduleName(node.exported));
      else if (source.startsWith(".")) {
        for (const name of exportedNames(resolveRelative(file, source), seen))
          if (name !== "default") names.add(name);
      } else names.add(`* from ${source}`);
    } else if (node.type === "ExportDefaultDeclaration") {
      names.add("default");
    } else if (node.type === "TSExportAssignment") names.add("export=");
  }
  return names;
}

export function currentBarrel(root) {
  return [...exportedNames(path.join(root, sharedBarrel.entry))].sort();
}

export function readBaseline(root) {
  const file = path.join(root, sharedBarrel.baseline);
  return existsSync(file)
    ? readFileSync(file, "utf8").split("\n").filter(Boolean)
    : [];
}

export function writeBaseline(root, names) {
  writeFileSync(
    path.join(root, sharedBarrel.baseline),
    `${[...names].sort().join("\n")}\n`,
  );
}

/** Compare the barrel with its baseline; `[]` means the freeze holds. */
export function sharedBarrelErrors(root, current = currentBarrel(root)) {
  const baseline = new Set(readBaseline(root));
  const now = new Set(current);
  const added = current.filter((name) => !baseline.has(name));
  const removed = [...baseline].filter((name) => !now.has(name)).sort();
  const errors = [];
  if (added.length) {
    const entries = Object.keys(
      JSON.parse(readFileSync(path.join(root, sharedBarrel.manifest), "utf8"))
        .exports ?? {},
    )
      .filter((key) => key !== ".")
      .join(", ");
    errors.push(
      `${sharedBarrel.entry}: the root entry of @covel/shared is frozen, but it gained ${added.length} export(s): ${added.join(", ")}. ` +
        `Put new code in a domain subpath entry (${entries}; new ones are named after the barrel's sections, such as ./protocol, ./manifest, ./world, ./llm, ./env, ./theme) and export it from packages/shared/package.json, not from the root. See docs/internals/packages.md.`,
    );
  }
  if (removed.length)
    errors.push(
      `${sharedBarrel.baseline}: ${removed.length} export(s) left the root entry: ${removed.join(", ")}. ` +
        "Shrink the baseline with `node scripts/shared-barrel-baseline.mjs --update`.",
    );
  return errors;
}
