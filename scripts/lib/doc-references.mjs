import { parseSync } from "oxc-parser";

function* nodes(filename, source) {
  const parsed = parseSync(filename, source);
  if (parsed.errors.length)
    throw new Error(`${filename}: ${parsed.errors[0].message}`);
  const pending = [parsed.program];
  while (pending.length) {
    const node = pending.pop();
    yield node;
    for (const value of Object.values(node)) {
      if (Array.isArray(value))
        pending.push(
          ...value.filter((item) => item && typeof item.type === "string"),
        );
      else if (
        value &&
        typeof value === "object" &&
        typeof value.type === "string"
      )
        pending.push(value);
    }
  }
}

/** Read registration keys, not renderer names (Image's renderer is ImageComponent). */
export function catalogNames(source) {
  for (const node of nodes("catalog.tsx", source)) {
    if (
      node.type !== "VariableDeclarator" ||
      node.id.name !== "covelComponents"
    )
      continue;
    const object =
      node.init.type === "TSSatisfiesExpression"
        ? node.init.expression
        : node.init;
    return new Set(
      object.properties.map(
        (property) => property.key.name ?? property.key.value,
      ),
    );
  }
  throw new Error("Could not find the web component catalog");
}

export function sourceNames(filename, source) {
  const names = new Set();
  for (const node of nodes(filename, source)) {
    if (
      ["FunctionDeclaration", "VariableDeclarator"].includes(node.type) &&
      node.id?.name
    )
      names.add(node.id.name);
    if (
      [
        "MethodDefinition",
        "Property",
        "TSMethodSignature",
        "TSPropertySignature",
        "PropertyDefinition",
      ].includes(node.type) &&
      !node.computed
    ) {
      const name = node.key?.name ?? node.key?.value;
      if (typeof name === "string") names.add(name);
    }
    if (
      node.type === "AssignmentExpression" &&
      node.left.type === "MemberExpression" &&
      !node.left.computed
    )
      names.add(node.left.property.name);
    // Re-exported dependencies (e.g. createStore from a third-party library).
    if (node.type === "ImportSpecifier") names.add(node.local.name);
  }
  return names;
}

export function specComponentReferences(text) {
  const names = new Set();
  for (const match of text.matchAll(
    /["']?(?:component|type)["']?\s*:\s*["']([A-Z][A-Za-z0-9]*)["']/g,
  ))
    names.add(match[1]);
  return names;
}

export function componentReferences(text) {
  const names = specComponentReferences(text);
  // Inline names in prose/tables also count, even if no example uses them.
  for (const match of text
    .replace(/```[\s\S]*?```/g, "")
    .matchAll(/`([A-Z][A-Za-z0-9]*)`/g))
    names.add(match[1]);
  return names;
}

export function apiReferences(text) {
  const names = new Set();
  for (const inline of text
    .replace(/```[\s\S]*?```/g, "")
    .matchAll(/`([^`\n]+)`/g)) {
    for (const match of inline[1].matchAll(
      /\b([a-z][a-zA-Z0-9]*[A-Z][a-zA-Z0-9]*)\s*\(/g,
    ))
      names.add(match[1]);
  }
  return names;
}

export function missingReferences(names, known, allowlist = {}) {
  return [...names].filter(
    (name) => !known.has(name) && !allowlist[name]?.trim(),
  );
}
