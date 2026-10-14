/**
 * Types derived from the PLUGIN.md frontmatter schemas.
 *
 * Split from `plugin-schemas.ts` (the Zod definitions); `plugin.ts`
 * re-exports both.
 */

import type { z } from "zod";

import type { runtimeManifestInputSchema } from "./plugin-schemas.js";

export type RuntimeManifestInput = z.input<typeof runtimeManifestInputSchema>;
