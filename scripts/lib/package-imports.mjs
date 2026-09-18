import { parseSync } from "oxc-parser";

/** Parse syntax so comments, import types and mixed imports keep their meaning. */
export function packageImports(filename, source) {
  const parsed = parseSync(filename, source);
  if (parsed.errors.length)
    throw new Error(`${filename}: ${parsed.errors[0].message}`);
  const imports = [];
  const nodes = [parsed.program];
  while (nodes.length) {
    const node = nodes.pop();
    if (
      [
        "ImportDeclaration",
        "ExportNamedDeclaration",
        "ExportAllDeclaration",
      ].includes(node.type) &&
      node.source
    ) {
      imports.push({
        specifier: node.source.value,
        typeOnly:
          node.importKind === "type" ||
          node.exportKind === "type" ||
          Boolean(
            node.specifiers?.length &&
            node.specifiers.every(
              (entry) =>
                entry.importKind === "type" || entry.exportKind === "type",
            ),
          ),
      });
    } else if (
      node.type === "ImportExpression" &&
      typeof node.source?.value === "string"
    ) {
      imports.push({ specifier: node.source.value, typeOnly: false });
    } else if (
      node.type === "TSImportType" &&
      typeof node.source?.value === "string"
    ) {
      imports.push({ specifier: node.source.value, typeOnly: true });
    }
    for (const value of Object.values(node)) {
      if (Array.isArray(value))
        nodes.push(
          ...value.filter((entry) => entry && typeof entry.type === "string"),
        );
      else if (
        value &&
        typeof value === "object" &&
        typeof value.type === "string"
      )
        nodes.push(value);
    }
  }
  return imports;
}
