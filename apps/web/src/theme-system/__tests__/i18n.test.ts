import type { TFunction } from "i18next";
import { beforeAll, describe, expect, it } from "vitest";
import i18n, { i18nReady } from "@/i18n";
import { localizeTokenGroups } from "../i18n.js";
import { FONT_STACKS, TOKEN_GROUPS } from "../token-schema.js";

function findToken(name: string) {
  const token = TOKEN_GROUPS.flatMap((group) => group.tokens).find(
    (spec) => spec.name === name,
  );
  if (!token) throw new Error(`Missing token fixture: ${name}`);
  return token;
}

describe("appearance token catalog", () => {
  beforeAll(async () => {
    await i18nReady;
  });

  it("uses Russian catalog text for groups, tokens, hints and options", async () => {
    await i18n.changeLanguage("ru-RU");
    const groups = localizeTokenGroups(
      TOKEN_GROUPS,
      "ru-RU",
      i18n.getFixedT("ru-RU"),
    );

    expect(groups[0]?.label).toBe("Повествование");
    expect(groups[0]?.description).toContain("сюжетной колонки");

    const tokens = groups.flatMap((group) => group.tokens);
    const columnWidth = tokens.find(
      (token) => token.name === "--story-max-width",
    );
    expect(columnWidth?.label).toBe("Ширина текстовой колонки");
    expect(columnWidth?.hint).toContain("Узкие строки");

    const font = tokens.find((token) => token.name === "--story-font-family");
    expect(font?.options?.find((option) => option.id === "sans")?.label).toBe(
      "Без засечек",
    );

    const rule = tokens.find((token) => token.name === "--rule-style");
    expect(rule?.options?.find((option) => option.id === "dashed")?.label).toBe(
      "Штриховая",
    );
  });

  it("lets a newly contributed locale override stable ids using catalog text only", () => {
    const catalog = new Map<string, string>([
      ["appearance.tokenEditor.groups.story.label", "物語"],
      [
        "appearance.tokenEditor.tokens.--story-font-family.label",
        "本文フォント",
      ],
      [
        "appearance.tokenEditor.tokens.--story-font-family.options.sans",
        "ゴシック体",
      ],
    ]);
    const t = ((key: string, options?: { defaultValue?: string }) =>
      catalog.get(key) ?? options?.defaultValue ?? key) as unknown as TFunction;

    const groups = localizeTokenGroups(TOKEN_GROUPS, "ja-JP", t);
    const story = groups.find((group) => group.id === "story");
    const font = story?.tokens.find(
      (token) => token.name === "--story-font-family",
    );

    expect(story?.label).toBe("物語");
    expect(font?.label).toBe("本文フォント");
    expect(font?.options?.find((option) => option.id === "sans")?.label).toBe(
      "ゴシック体",
    );
    expect(
      groups
        .flatMap((group) => group.tokens)
        .find((token) => token.name === "--story-font-size")?.label,
    ).toBe("Body size");
  });

  it("gives every catalog-backed option a stable id and complete built-in keys", () => {
    for (const option of FONT_STACKS) expect(option.id).toBeTruthy();
    for (const group of TOKEN_GROUPS) {
      for (const locale of ["en-US", "zh-CN", "ru-RU"]) {
        expect(
          i18n.exists(`appearance.tokenEditor.groups.${group.id}.label`, {
            lng: locale,
          }),
        ).toBe(true);
        expect(
          i18n.exists(`appearance.tokenEditor.groups.${group.id}.description`, {
            lng: locale,
          }),
        ).toBe(true);
      }

      for (const spec of group.tokens) {
        expect(findToken(spec.name)).toBe(spec);
        for (const locale of ["en-US", "zh-CN", "ru-RU"]) {
          expect(
            i18n.exists(`appearance.tokenEditor.tokens.${spec.name}.label`, {
              lng: locale,
            }),
          ).toBe(true);
          if (spec.hint) {
            expect(
              i18n.exists(`appearance.tokenEditor.tokens.${spec.name}.hint`, {
                lng: locale,
              }),
            ).toBe(true);
          }
        }
        const options =
          spec.options ?? (spec.control === "font" ? FONT_STACKS : []);
        for (const option of options) {
          expect(option.id).toBeTruthy();
          for (const locale of ["en-US", "zh-CN", "ru-RU"]) {
            expect(
              i18n.exists(
                `appearance.tokenEditor.tokens.${spec.name}.options.${option.id}`,
                { lng: locale },
              ),
            ).toBe(true);
          }
        }
      }
    }
  });
});
