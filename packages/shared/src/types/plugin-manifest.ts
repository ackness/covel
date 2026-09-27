import type { z } from "zod";
import type { pluginManifestSchema } from "../schemas/plugin-manifest.js";
/** Authoring contract stored only at the package root. */
export type PluginManifest = z.infer<typeof pluginManifestSchema>;
