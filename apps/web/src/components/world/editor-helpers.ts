import i18n from "@/i18n/index.js";
import type { WorldDimensions } from "@covel/shared";
import { resolveDisplayText } from "@/lib/i18n-text.js";

type I18nText = string | Record<string, string>;

export function text(v: I18nText | undefined, locale?: string): string {
  return resolveDisplayText(v, locale ?? i18n.language);
}

/** Shared input class names */
export const inputCls =
  "w-full border border-border bg-background px-3 py-2 text-sm";
export const textareaCls =
  "w-full border border-border bg-background px-3 py-2 text-sm min-h-20 resize-y";
export const selectCls = "border border-border bg-background px-3 py-2 text-sm";

export type DimensionsState = WorldDimensions;

export interface TabProps {
  dimensions: DimensionsState;
  onChange: (next: DimensionsState) => void;
  t: (key: string) => string;
}
