import type { I18nText, LocaleCode, PluginId } from "./common.types";

export interface WorldContentVariant {
  locale: LocaleCode;
  path: string;
  title?: I18nText;
}

export interface WorldPackage {
  schemaVersion: "covel.world-package/v0alpha1";
  id: string;
  name: I18nText;
  version: string;
  summary: I18nText;
  /**
   * Package-level default locale. Defaults to zh-CN but world authors may choose another locale.
   */
  defaultLocale: LocaleCode;
  /**
   * Package-level locale support for metadata selection and runtime locale negotiation.
   * Actual markdown coverage is determined by contentVariants.
   */
  supportedLocales: LocaleCode[];
  /**
   * Character field contract. Can be a relative file path to a JSON Schema (string)
   * or an inline JSON Schema object.
   */
  characterSchema: string | Record<string, unknown>;
  requiredPlugins?: PluginId[];
  recommendedPlugins?: PluginId[];
  /**
   * Actual markdown content variants provided by the author.
   * At least one zh-CN variant must exist; other locale variants are optional.
   */
  contentVariants: WorldContentVariant[];
}
