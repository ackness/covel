import type { LorebookOwner } from "@covel/shared";

/** Stable SQL identity, independent of JSON object property order. */
export function lorebookOwnerKey(owner: LorebookOwner): string {
  return owner.kind === "plugin" ? `plugin:${owner.pluginId}` : owner.kind;
}

export function parseLorebookOwnerKey(value: string): LorebookOwner {
  if (value === "world" || value === "player") return { kind: value };
  if (value.startsWith("plugin:") && value.length > 7) {
    return { kind: "plugin", pluginId: value.slice(7) };
  }
  throw new Error("Invalid stored lorebook owner");
}
