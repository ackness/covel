import { describe, expect, it } from "vitest";
import {
  projectDimensionSnapshot,
  type DimensionSnapshot,
} from "@covel/shared";
import { buildWorldContextView } from "../src/session-context-views.js";

const dimensions: DimensionSnapshot = {
  factions: {
    name: "Factions",
    schema: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id: { type: "string" },
          name: { type: "string", "x-i18n": true },
        },
      },
    },
    // Session state holds one language: the world's locale maps were
    // resolved when the world was imported.
    value: [{ id: "salt-fangs", name: "盐牙会" }],
    version: 3,
  },
  codes: {
    name: "Codes",
    schema: { type: "object", additionalProperties: { type: "string" } },
    value: { "zh-CN": "business-a", "en-US": "business-b" },
    version: 1,
  },
};
function view(locale: string) {
  return buildWorldContextView({
    worldRecord: {
      id: "w1",
      name: "W",
      description: "Summary",
      tags: ["fog"],
      createdAt: "2026-01-01T00:00:00Z",
    },
    schemaMap: undefined,
    entriesMap: undefined,
    dimensions,
    locale,
  });
}
describe("buildWorldContextView frozen dimensions", () => {
  it("keeps the same versioned raw public values, with a detached snapshot", () => {
    const current = view("zh-CN");
    expect(current.dimensions).toEqual(dimensions);
    expect(current.dimensions).not.toBe(dimensions);
    expect(current.name).toBe("W");
    expect(current.tags).toEqual(["fog"]);
  });
  it("projects stored values as they are, whatever the request language", () => {
    for (const locale of ["zh-CN", "ja-JP"]) {
      const projection = projectDimensionSnapshot(
        view(locale).dimensions!,
        locale,
      );
      expect(projection).toContain("盐牙会");
      expect(projection).toContain("salt-fangs");
      // Ordinary data keyed by language codes is not translatable text.
      expect(projection).toContain("business-a");
      expect(projection).toContain("business-b");
    }
  });
});
