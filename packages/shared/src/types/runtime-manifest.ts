import type { z } from "zod";
import type { runtimeAuthoringManifestSchema } from "../schemas/runtime-manifest.js";
/** Authoring contract in RUNTIME.md or the package's inline runtime block. */
export type RuntimeAuthoringManifest = z.infer<
  typeof runtimeAuthoringManifestSchema
>;
