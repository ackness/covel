/** Fields consumed from runtime manifests, never from a multi-runtime package root. */
const RUNTIME_DECLARATION_FIELDS = [
  "ui",
  "userSettings",
  "dataSchemas",
] as const;

export function multiRuntimeRootDiagnostics(
  frontmatter: Readonly<Record<string, unknown>>,
): readonly { readonly path: string; readonly message: string }[] {
  return RUNTIME_DECLARATION_FIELDS.filter((field) =>
    Object.hasOwn(frontmatter, field),
  ).map((field) => ({
    path: field,
    message:
      `"${field}" is ignored in a multi-runtime root PLUGIN.md. ` +
      "Move this declaration to a runtimes/<name>/PLUGIN.md; " +
      "the root's metadata and entry may stay here.",
  }));
}
