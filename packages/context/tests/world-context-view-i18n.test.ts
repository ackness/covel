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
    value: [
      { id: "salt-fangs", name: { "zh-CN": "盐牙会", "en-US": "Salt-Fangs" } },
    ],
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
describe("buildWorldContextView frozen dimensions and explicit localization", () => {
  it("keeps the same versioned raw public values, with a detached snapshot", () => {
    const current = view("zh-CN");
    expect(current.dimensions).toEqual(dimensions);
    expect(current.dimensions).not.toBe(dimensions);
    expect(current.name).toBe("W");
    expect(current.tags).toEqual(["fog"]);
  });
  it("localizes only marked fields in bounded model projections", () => {
    const projection = projectDimensionSnapshot(
      view("zh-CN").dimensions!,
      "zh-CN",
    );
    expect(projection).toContain("盐牙会");
    expect(projection).not.toContain("Salt-Fangs");
    expect(projection).toContain("salt-fangs");
    expect(projection).toContain("business-a");
    expect(projection).toContain("business-b");
  });
  it("uses the shared locale resolver only on explicitly localized fields", () => {
    expect(
      projectDimensionSnapshot(view("ja-JP").dimensions!, "ja-JP"),
    ).toContain("Salt-Fangs");
  });
});
