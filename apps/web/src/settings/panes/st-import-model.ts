import type { StImportItem } from "@covel/shared";

export function groupImportItems(items: readonly StImportItem[]) {
  return (["error", "warning", "info"] as const)
    .map((level) => ({
      level,
      items: items.filter((item) => item.level === level),
    }))
    .filter((group) => group.items.length > 0);
}
export function importItemText(
  item: StImportItem,
  translate: (key: string) => string,
  exists: (key: string) => boolean,
): string {
  const key = `settings.stImport.codes.${item.code}`;
  const translated = exists(key);
  const details =
    translated && ["macros-removed", "extensions-ignored"].includes(item.code)
      ? item.message.slice(item.message.indexOf(":") + 1).trim()
      : "";
  const message =
    (translated ? translate(key) : item.message) +
    (details ? ` ${details}` : "");
  return `${message}${item.field ? ` · ${item.field}` : ""}${item.count !== undefined ? ` (${item.count})` : ""}`;
}
