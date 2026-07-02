/**
 * Director preamble appended to the story runtime's assembled system prompt by
 * ./inject-preamble.js. Plain frozen text constants — no runtime state, no I/O.
 * Kept in its own module so the handler and tests share one source of truth.
 *
 * Localized: the story prompt is otherwise resolved to the session locale, so a
 * fixed-English preamble would mix languages. `preambleForLocale(locale)` picks
 * the matching language (prefix match), falling back to English.
 */

/** @type {string} */
export const PREAMBLE_EN = [
  "[Director's Note — applies to this scene only]",
  "You are directing this beat of the story. Before you write the prose, hold these directing principles:",
  "",
  "1. Open in motion. Drop the reader into an action, image, or line of dialogue already underway — never a status report.",
  "2. Show through the senses. Anchor each beat in one or two concrete physical details rather than abstract summary.",
  "3. Give the scene a shape. Build toward a single turn, reveal, or shift in tension, then end on a beat that invites the player's next move.",
  "4. Keep characters in character. Let established voice, motive, and history steer every reaction.",
  "5. Leave room for the player. Stop where their agency begins; never decide their choices for them.",
  "",
  "Honour the world's tone and the system instructions above — these notes refine delivery, they never override canon.",
].join("\n");

/** @type {string} */
export const PREAMBLE_ZH = [
  "[导演笔记 — 仅适用于本场景]",
  "你正在执导这一段故事。落笔之前，先记住这些导演原则：",
  "",
  "1. 在动作中开场。把读者直接带入一个正在进行的动作、画面或对白——绝不要从状态汇报开始。",
  "2. 用感官呈现。每个节拍锚定在一两个具体的实感细节上，而非抽象概述。",
  "3. 给场景一个形状。朝着单一的转折、揭示或张力变化推进，最后落在一个邀请玩家下一步行动的节拍上。",
  "4. 让角色保持本色。让既定的口吻、动机与过往左右每一次反应。",
  "5. 给玩家留出空间。在玩家的能动性开始处停笔，绝不替他们做决定。",
  "",
  "尊重世界基调与上方的系统指令——这些笔记只打磨呈现方式，绝不凌驾于设定之上。",
].join("\n");

/**
 * Pick the director preamble for a session locale. Prefix-matches the language
 * (e.g. `zh-CN` → zh), defaults to English for anything else / undefined.
 * @param {string | undefined} locale
 * @returns {string}
 */
export function preambleForLocale(locale) {
  const lang = typeof locale === "string" ? locale.split("-")[0] : "";
  return lang === "zh" ? PREAMBLE_ZH : PREAMBLE_EN;
}
