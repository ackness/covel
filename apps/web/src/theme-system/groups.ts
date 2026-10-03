import type { I18nText } from "@covel/shared";
import type { ThemeDefinition, ThemeManifest } from "./types.js";

/**
 * A style as the player picks it: one or more theme packages that share a
 * group. Each member is a colourway of the style and stays a complete,
 * independently selectable package — `ui.appearance` still stores a theme id.
 */
export interface ThemeGroup {
  readonly id: string;
  readonly label: I18nText;
  readonly members: readonly ThemeDefinition[];
}

/** A package without a group is a style of its own. */
export function themeGroupId(
  theme: Pick<ThemeManifest, "id" | "group">,
): string {
  return theme.group ?? theme.id;
}

/**
 * Group packages in the order given (registry order puts builtins first), so a
 * group sits where its first member does and a builtin's `groupLabel` cannot be
 * replaced by an imported package claiming the same group.
 */
export function groupThemes(themes: readonly ThemeDefinition[]): ThemeGroup[] {
  const groups = new Map<string, ThemeDefinition[]>();
  for (const theme of themes) {
    const id = themeGroupId(theme);
    const members = groups.get(id);
    if (members) members.push(theme);
    else groups.set(id, [theme]);
  }
  return [...groups].map(([id, members]) => ({
    id,
    label:
      members.find((member) => member.groupLabel !== undefined)?.groupLabel ??
      members.find((member) => member.id === id)?.label ??
      members[0]!.label,
    members,
  }));
}
