import path from "node:path";
import type { PluginRegistryEntry } from "@covel/plugin-loader";
import type { PluginLoadDiagnostics } from "@covel/shared";

/** Keep host installation paths out of every public plugin projection. */
export function buildPluginLoadDiagnostics(
  entry: PluginRegistryEntry,
): PluginLoadDiagnostics {
  function publicDiagnostic<T extends { sourcePath: string; message: string }>(
    diagnostic: T,
  ): T {
    const relative = entry.rootPath
      ? path.relative(entry.rootPath, diagnostic.sourcePath)
      : path.basename(diagnostic.sourcePath);
    const sourcePath = (
      relative === ".." ||
      relative.startsWith(`..${path.sep}`) ||
      path.isAbsolute(relative)
        ? path.basename(diagnostic.sourcePath)
        : relative
    )
      .split(path.sep)
      .join("/");
    const message = diagnostic.message
      .split(diagnostic.sourcePath)
      .join(sourcePath);
    return {
      ...diagnostic,
      sourcePath,
      message: entry.rootPath
        ? message.split(entry.rootPath).join("<plugin>")
        : message,
    };
  }
  return {
    ...(entry.disabledRuntimes?.length
      ? { disabledRuntimes: entry.disabledRuntimes.map(publicDiagnostic) }
      : {}),
    ...(entry.ignoredFields?.length
      ? { ignoredFields: entry.ignoredFields.map(publicDiagnostic) }
      : {}),
  };
}
