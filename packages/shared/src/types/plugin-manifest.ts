import type { z } from "zod";
import type { pluginManifestSchema } from "../schemas/plugin-manifest.js";
/** A root PLUGIN.md as written: `id` may be left out. */
export type PluginManifestInput = z.infer<typeof pluginManifestSchema>;
/**
 * The package manifest after parsing: `id` comes from the package directory
 * when the file does not write it.
 */
export type PluginManifest = Omit<PluginManifestInput, "id"> & {
  id: string;
};
