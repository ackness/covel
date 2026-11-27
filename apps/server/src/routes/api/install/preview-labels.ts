import { i18nTextSchema, type I18nText } from "@covel/shared";

export function clipPreviewText(value: I18nText, max: number): I18nText {
  return typeof value === "string"
    ? value.slice(0, max)
    : Object.fromEntries(
        Object.entries(value).map(([locale, text]) => [
          locale,
          text.slice(0, max),
        ]),
      );
}

export function packagePreviewLabels(
  rawName: unknown,
  rawTags: readonly string[] | undefined,
) {
  const name = i18nTextSchema.safeParse(rawName);
  const displayName =
    name.success &&
    (typeof name.data === "string"
      ? [name.data]
      : Object.values(name.data)
    ).some((text) => text.trim())
      ? clipPreviewText(name.data, 200)
      : undefined;
  const tags = rawTags
    ?.map((tag) => tag.trim().slice(0, 64))
    .filter(Boolean)
    .slice(0, 12);
  return {
    ...(displayName !== undefined ? { displayName } : {}),
    ...(tags?.length ? { tags } : {}),
  };
}
