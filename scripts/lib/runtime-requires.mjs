import { parseSync } from "oxc-parser";

/** Find native require calls, including esbuild renames and createRequire aliases. */
export function runtimeRequires(filename, source) {
  const parsed = parseSync(filename, source);
  if (parsed.errors.length)
    throw new Error(`${filename}: ${parsed.errors[0].message}`);
  const nodes = [];
  const pending = [parsed.program];
  while (pending.length) {
    const node = pending.pop();
    nodes.push(node);
    for (const value of Object.values(node)) {
      if (Array.isArray(value))
        pending.push(
          ...value.filter((entry) => entry && typeof entry.type === "string"),
        );
      else if (value && typeof value.type === "string") pending.push(value);
    }
  }
  const factories = new Set();
  for (const node of nodes) {
    if (
      node.type === "ImportDeclaration" &&
      ["module", "node:module"].includes(node.source.value)
    ) {
      for (const specifier of node.specifiers) {
        if (specifier.imported?.name === "createRequire")
          factories.add(specifier.local.name);
      }
    }
  }
  const memberName = (node) =>
    node?.type === "MemberExpression"
      ? node.computed
        ? node.property.value
        : node.property.name
      : undefined;
  const isFactory = (node) =>
    (node?.type === "Identifier" && factories.has(node.name)) ||
    memberName(node) === "createRequire";
  const requires = new Set();
  const isRequire = (node) =>
    (node?.type === "Identifier" &&
      (/^(?:__)?require\d*$/.test(node.name) || requires.has(node.name))) ||
    (node?.type === "CallExpression" && isFactory(node.callee)) ||
    memberName(node) === "require";
  // Follow assigned createRequire results and aliases, regardless of their
  // declaration order. No dependency code is executed during release checks.
  let changed;
  do {
    changed = false;
    for (const node of nodes) {
      const name =
        node.type === "VariableDeclarator"
          ? node.id
          : node.type === "AssignmentExpression" && node.operator === "="
            ? node.left
            : undefined;
      const value = node.init ?? node.right;
      if (
        name?.type === "Identifier" &&
        !requires.has(name.name) &&
        isRequire(value)
      ) {
        requires.add(name.name);
        changed = true;
      }
    }
  } while (changed);

  const imports = [];
  for (const node of nodes) {
    if (
      node.type !== "CallExpression" ||
      !(
        isRequire(node.callee) ||
        (memberName(node.callee) === "resolve" && isRequire(node.callee.object))
      )
    )
      continue;
    const argument = node.arguments[0];
    const specifier =
      argument?.type === "Literal"
        ? argument.value
        : argument?.type === "TemplateLiteral" && !argument.expressions.length
          ? argument.quasis[0].value.cooked
          : undefined;
    if (typeof specifier === "string")
      imports.push({ specifier, start: node.start });
  }
  return imports
    .sort((a, b) => a.start - b.start)
    .map((entry) => entry.specifier);
}
