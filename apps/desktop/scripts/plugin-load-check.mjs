/** Health can succeed even when a bundled plugin failed to initialize. */
export function assertNoPluginLoadErrors(stderrChunks) {
  // stderr chunks can split a log marker anywhere, including inside a word.
  const offending = stderrChunks
    .join("")
    .split(/\r?\n/)
    .filter((line) =>
      /ERR_MODULE_NOT_FOUND|Cannot find package|\[bootstrap\] Failed to load|\[ui-specs\] Failed to load runtime|\[plugin-entry\].*failed to activate entry/.test(
        line,
      ),
    );
  if (offending.length > 0) {
    throw new Error(
      "staged server logged plugin-load failures — a packaged build must not " +
        `ship plugins that fail to load:\n${offending.slice(-40).join("\n")}`,
    );
  }
}

/** Exercise actual staged entry imports, including plugin-only workspace dependencies. */
export function assertLoadedBuiltinPluginEntries(items) {
  if (!Array.isArray(items))
    throw new Error("staged /api/plugins returned no items");
  for (const id of ["affinity", "codex", "core-quest", "dice-check"]) {
    const plugin = items.find((item) => item?.id === id);
    if (plugin?.source !== "builtin" || plugin.hostState !== "loaded") {
      throw new Error(
        `staged builtin plugin entry ${id} is not loaded: ${plugin?.hostState ?? "missing"}`,
      );
    }
  }
}
