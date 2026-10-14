import { loadSingleWorld } from "../world-seed-loader.js";

/** The same package read-back preflight for ZIP installation and AI write-back.
 * Local overrides are not part of the package being published. Ordinary catalogue
 * loading remains tolerant; a failed publication leaves the last good package.
 */
export async function loadWorldForPublication(
  worldDir: string,
  options: Parameters<typeof loadSingleWorld>[1] = {},
) {
  const record = await loadSingleWorld(worldDir, {
    ...options,
    includeWorldDataOverrides: false,
    onWorldDataDiagnostics(diagnostics) {
      const errors = diagnostics.filter((item) => item.level === "error");
      if (errors.length)
        throw new Error(
          `Invalid worldData:\n${errors
            .map(
              (item) =>
                `${item.sourceId ? `${item.sourceId}: ` : ""}${item.message}`,
            )
            .join("\n")}`,
        );
    },
  });
  if (!record) throw new Error("World package could not be loaded");
  return record;
}
