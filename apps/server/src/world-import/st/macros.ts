import { localeLanguage } from "@covel/shared";
import { safeFieldName } from "./report.js";

/** Scan fixed delimiters; never evaluate a macro or build a pattern from it. */
export function resolveMacros(
  input: string,
  name: string,
  locale: string,
): { text: string; removed: number; names: string[] } {
  let removed = 0;
  const names = new Set<string>();
  const player = localeLanguage(locale) === "zh" ? "玩家" : "the player";
  // {{char}} and <BOT> need a character in scope; without one they are
  // dropped and reported rather than silently emptied.
  const unresolved = (label: string) => {
    removed++;
    if (names.size < 10) names.add(safeFieldName(label));
  };
  const starts = /\{\{|<BOT>|<USER>/gi;
  let cursor = 0;
  let text = "";
  for (let match = starts.exec(input); match; match = starts.exec(input)) {
    text += input.slice(cursor, match.index);
    if (match[0].toUpperCase() === "<BOT>") {
      if (name) text += name;
      else unresolved("BOT");
      cursor = starts.lastIndex;
      continue;
    }
    if (match[0].toUpperCase() === "<USER>") {
      text += player;
      cursor = starts.lastIndex;
      continue;
    }
    const end = input.indexOf("}}", starts.lastIndex);
    if (end < 0) {
      text += input.slice(match.index);
      cursor = input.length;
      break;
    }
    const key = input.slice(starts.lastIndex, end).trim().toLowerCase();
    cursor = end + 2;
    starts.lastIndex = cursor;
    if (key === "char") {
      if (name) text += name;
      else unresolved("char");
    } else if (key === "user") text += player;
    else if (key !== "original" && !key.startsWith("//")) {
      unresolved(key.split(/::|:/)[0] ?? "");
    }
  }
  return { text: text + input.slice(cursor), removed, names: [...names] };
}
