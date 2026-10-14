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
