import type { TFunction } from "i18next";
import { resolveI18nText } from "@covel/shared";
import {
  FONT_STACKS,
  type TokenGroup,
  type TokenOption,
  type TokenSpec,
} from "./token-schema.js";

function fallbackText(
  value: TokenGroup["label"] | TokenSpec["hint"],
  locale: string,
  stableId: string,
): string {
  return (
    resolveI18nText(value, locale) ??
    resolveI18nText(value, "en-US") ??
    stableId
  );
}

function catalogText(t: TFunction, key: string, fallback: string): string {
  return t(key, { defaultValue: fallback });
}

function localizeOption(
  option: TokenOption,
  tokenName: string,
  locale: string,
  t: TFunction,
): TokenOption {
  const id = option.id ?? option.value;
  return {
    ...option,
    label: catalogText(
      t,
      `appearance.tokenEditor.tokens.${tokenName}.options.${id}`,
      fallbackText(option.label, locale, id),
    ),
  };
}

function localizeToken(
  spec: TokenSpec,
  locale: string,
  t: TFunction,
): TokenSpec {
  const prefix = `appearance.tokenEditor.tokens.${spec.name}`;
  const options =
    spec.options ?? (spec.control === "font" ? FONT_STACKS : undefined);
  return {
    ...spec,
    label: catalogText(
      t,
      `${prefix}.label`,
      fallbackText(spec.label, locale, spec.name),
    ),
    hint: spec.hint
      ? catalogText(
          t,
          `${prefix}.hint`,
          fallbackText(spec.hint, locale, spec.name),
        )
      : undefined,
    options: options?.map((option) =>
      localizeOption(option, spec.name, locale, t),
    ),
  };
}

/** Overlay core token metadata with the active Web catalog without changing stable ids. */
export function localizeTokenGroups(
  groups: readonly TokenGroup[],
  locale: string,
  t: TFunction,
): readonly TokenGroup[] {
  return groups.map((group) => {
    const prefix = `appearance.tokenEditor.groups.${group.id}`;
    return {
      ...group,
      label: catalogText(
        t,
        `${prefix}.label`,
        fallbackText(group.label, locale, group.id),
      ),
      description: catalogText(
        t,
        `${prefix}.description`,
        fallbackText(group.description, locale, group.id),
      ),
      tokens: group.tokens.map((spec) => localizeToken(spec, locale, t)),
    };
  });
}
