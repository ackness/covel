/** The same layout rule applies to disk discovery and extracted bundles. */
export function runtimeDirectoryDiagnostics(
  directory: string,
  files: readonly string[],
): { error?: string; warning?: string } {
  const misnamedManifest = files.find((file) =>
    /^PLUGIN(?:\.[a-zA-Z0-9-]+)?\.md$/.test(file),
  );
  if (misnamedManifest)
    return {
      error: `${directory}/${misnamedManifest}: runtime manifests must be named RUNTIME.md`,
    };
  if (!files.includes("RUNTIME.md"))
    return {
      warning: `${directory}/RUNTIME.md: missing runtime manifest; each directory under runtimes/ must contain RUNTIME.md; put shared code in lib/`,
    };
  return {};
}
