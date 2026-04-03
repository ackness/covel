import type { I18nText, Locale } from "./common.js";
import type { WorldDimensions } from "./world-dimensions.js";

/**
 * WorldPackageMeta is now inferred from worldPackageMetaSchema in schemas/world.ts.
 * Re-exported from there via the barrel (index.ts).
 */

/** World content variant */
export interface WorldContentVariant {
  locale: Locale;
  /** Path to markdown file relative to world package root */
  path: string;
}

/** Character pack metadata */
export interface CharacterPackMeta {
  id: string;
  worldId: string;
  name: I18nText;
  locale: Locale;
  fields: Record<string, unknown>;
}
