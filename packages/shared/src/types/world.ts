import type { I18nText, Locale } from "./common.js";
import type { WorldDimensions } from "./world-dimensions.js";

/** World package metadata */
export interface WorldPackageMeta {
  schemaVersion: string;
  id: string;
  name: I18nText;
  version: string;
  summary: I18nText;
  defaultLocale: Locale;
  supportedLocales: Locale[];
  characterSchema?: unknown;
  requiredPlugins?: string[];
  recommendedPlugins?: string[];
  contentVariants: WorldContentVariant[];
  /** Structured world-building dimensions */
  dimensions?: WorldDimensions;
}

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
