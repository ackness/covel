import {
  localeTier,
  resolveI18nText,
  type LocaleDefinition,
} from "@covel/shared";

/**
 * The name of a language in a language switcher. A language that has an
 * interface catalog and no instruction set of its own is marked: sessions in
 * it give the models English instructions, so the story quality depends on
 * the model.
 */
export function localeOptionLabel(
  definition: LocaleDefinition,
  displayLocale: string,
  experimental: string,
): string {
  const name =
    resolveI18nText(definition.label, displayLocale) ?? definition.code;
  return localeTier(definition.code) === "extended"
    ? `${name} (${experimental})`
    : name;
}
