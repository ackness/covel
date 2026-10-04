import i18n from "@/i18n/index.js";
import type { I18nText } from "@covel/shared";
import { resolveDisplayText } from "@/lib/i18n-text.js";

/**
 * Resolve an {@link I18nText} value to a display string for the active locale.
 *
 * Behaviour mirrors the historical local helper in world-detail-view: prefer an
 * exact language match, then a language-prefix match (`zh-CN` → `zh`), then the
 * first available value.
 */
export function text(v: I18nText | undefined): string {
  return resolveDisplayText(v, i18n.language);
}
