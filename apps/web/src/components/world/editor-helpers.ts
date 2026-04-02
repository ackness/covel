import type { WorldDimensions } from "@covel/shared";

type I18nText = string | Record<string, string>;

export function text(v: I18nText | undefined): string {
  if (!v) return "";
  return typeof v === "string" ? v : Object.values(v)[0] ?? "";
}

/** Shared input class names */
export const inputCls =
  "w-full border border-border bg-background px-3 py-2 text-sm";
export const textareaCls =
  "w-full border border-border bg-background px-3 py-2 text-sm min-h-[80px] resize-y";
export const selectCls =
  "border border-border bg-background px-3 py-2 text-sm";

export type DimensionsState = WorldDimensions;

export interface TabProps {
  dimensions: DimensionsState;
  onChange: (next: DimensionsState) => void;
  t: (key: string) => string;
}
