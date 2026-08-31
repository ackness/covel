/**
 * Director preamble appended to the story runtime's assembled system prompt by
 * ./inject-preamble.js. Plain frozen text constants — no runtime state, no I/O.
 * Kept in its own module so the handler and tests share one source of truth.
 *
 * Localized: the story prompt is otherwise resolved to the session locale, so a
 * fixed-English preamble would mix languages. `preambleForLocale(locale)` picks
 * the matching language (prefix match), falling back to English.
 */
import { pickLocaleText } from "@covel/plugin-handlers-utils";

/** @type {string} */
export const PREAMBLE_EN = [
  "[Director's Note — applies to this scene only]",
  "Open in motion or dialogue, ground the beat in one or two sensory details, and build toward one turn or reveal. Keep established motives and voices; stop where player agency begins. These notes refine delivery and never override canon or the instructions above.",
].join("\n");

/** @type {string} */
export const PREAMBLE_ZH = [
  "[导演笔记 — 仅适用于本场景]",
  "从动作或对白开场，以一两处感官细节推进到单一转折或揭示。保持既定动机与口吻，在玩家能动性开始处停笔；本笔记只打磨呈现，不凌驾于设定或上方指令。",
].join("\n");

/**
 * Pick the director preamble for a session locale. Prefix-matches the language
 * (e.g. `zh-CN` → zh), defaults to English for anything else / undefined.
 * @param {string | undefined} locale
 * @returns {string}
 */
export function preambleForLocale(locale) {
  return pickLocaleText(locale, PREAMBLE_ZH, PREAMBLE_EN);
}
