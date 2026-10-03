// @vitest-environment node
import { describe, expect, it } from "vitest";
import { groupThemes, themeGroupId } from "../groups.js";
import type { ThemeDefinition } from "../types.js";

function theme(
  id: string,
  extra: Partial<ThemeDefinition> = {},
): ThemeDefinition {
  return {
    id,
    label: id,
    source: "builtin",
    schemes: ["dark"],
    cssText: "",
    ...extra,
  };
}

describe("theme groups", () => {
  it("treats a package without a group as a style of its own", () => {
    expect(themeGroupId(theme("panel"))).toBe("panel");
    expect(groupThemes([theme("panel"), theme("book")])).toMatchObject([
      { id: "panel", label: "panel" },
      { id: "book", label: "book" },
    ]);
  });

  it("merges packages sharing a group, placed at its first member", () => {
    const groups = groupThemes([
      theme("panel"),
      theme("paper", { group: "classic", groupLabel: "Classic" }),
      theme("book"),
      theme("modern", { group: "classic", groupLabel: "Classic" }),
    ]);
    expect(groups.map((group) => group.id)).toEqual([
      "panel",
      "classic",
      "book",
    ]);
    expect(groups[1]?.label).toBe("Classic");
    expect(groups[1]?.members.map((member) => member.id)).toEqual([
      "paper",
      "modern",
    ]);
  });

  it("names a group after the first declared label, else its namesake", () => {
    // A later package cannot rename a group an earlier one already labelled.
    expect(
      groupThemes([
        theme("paper", { group: "classic", groupLabel: "Classic" }),
        theme("mine", { group: "classic", groupLabel: "Hijacked" }),
      ])[0]?.label,
    ).toBe("Classic");
    // No label declared: the package the group is named after supplies it.
    expect(
      groupThemes([
        theme("panel", { label: "Panel" }),
        theme("panel-ocean", { label: "Ocean", group: "panel" }),
      ])[0],
    ).toMatchObject({ id: "panel", label: "Panel" });
  });
});
