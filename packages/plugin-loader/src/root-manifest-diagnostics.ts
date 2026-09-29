/** Current authoring documents have one explicit runtime block. */
export function hasRuntimeDeclaration(manifest: object): boolean {
  return "runtime" in manifest || "runtimeType" in manifest;
}
export function multiRuntimeRootDiagnostics(
  frontmatter: object,
): readonly { readonly path: string; readonly message: string }[] {
  return "runtime" in frontmatter
    ? [
        {
          path: "runtime",
          message: "Inline runtime cannot coexist with runtimes/",
        },
      ]
    : [];
}
