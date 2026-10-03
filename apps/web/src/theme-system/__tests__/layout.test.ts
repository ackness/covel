import { beforeEach, describe, expect, it } from "vitest";
import {
  applyThemeLayout,
  parseThemeLayoutSpec,
  resolveThemeLayout,
  THEME_LAYOUT_PRESETS,
} from "../layout.js";

describe("theme layout", () => {
  beforeEach(() => {
    for (const name of [
      "data-layout",
      "data-nav",
      "data-panel-tabs",
      "data-backdrop",
      "data-world-list",
      "data-turn-notes",
    ]) {
      document.documentElement.removeAttribute(name);
    }
  });

  it("falls back to the classic preset when a package declares no layout", () => {
    expect(resolveThemeLayout(undefined)).toEqual({
      preset: "classic",
      ...THEME_LAYOUT_PRESETS.classic,
    });
  });

  it("lets a package override single options of its preset", () => {
    expect(resolveThemeLayout({ preset: "panel", nav: "top" })).toEqual({
      preset: "panel",
      ...THEME_LAYOUT_PRESETS.panel,
      nav: "top",
    });
  });

  it("drops a layout with unknown presets, options or keys", () => {
    expect(parseThemeLayoutSpec({ preset: "book" })).toEqual({
      preset: "book",
    });
    expect(parseThemeLayoutSpec({ preset: "carousel" })).toBeUndefined();
    expect(parseThemeLayoutSpec({ nav: "bottom" })).toBeUndefined();
    expect(
      parseThemeLayoutSpec({ preset: "book", sidebar: true }),
    ).toBeUndefined();
    expect(parseThemeLayoutSpec("book")).toBeUndefined();
  });

  it("publishes every option on the document root", () => {
    applyThemeLayout(resolveThemeLayout({ preset: "stage" }));
    const root = document.documentElement;
    expect(root.getAttribute("data-layout")).toBe("stage");
    expect(root.getAttribute("data-nav")).toBe("top");
    expect(root.getAttribute("data-panel-tabs")).toBe("bar");
    expect(root.getAttribute("data-backdrop")).toBe("scene");
    expect(root.getAttribute("data-world-list")).toBe("showcase");
    expect(root.getAttribute("data-turn-notes")).toBe("inline");
  });

  it("accepts the banner backdrop and margin notes as single overrides", () => {
    const spec = parseThemeLayoutSpec({
      backdrop: "banner",
      turnNotes: "margin",
    });
    expect(resolveThemeLayout(spec)).toEqual({
      preset: "classic",
      ...THEME_LAYOUT_PRESETS.classic,
      backdrop: "banner",
      turnNotes: "margin",
    });
    expect(parseThemeLayoutSpec({ turnNotes: "popup" })).toBeUndefined();
  });
});
