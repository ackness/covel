import { describe, it, expect } from "vitest";
import { resolveUserSettings } from "../src/turn-executor/turn-executor-helpers.js";
import type { RuntimeManifest } from "@covel/shared";

const specs = [
  { key: "ratio", type: "number", default: 70, min: 30, max: 90 },
  {
    key: "mode",
    type: "select",
    default: "medium",
    options: [
      { value: "short", label: "S" },
      { value: "medium", label: "M" },
      { value: "long", label: "L" },
    ],
  },
  { key: "on", type: "toggle", default: true },
  { key: "count", type: "integer", default: 2, min: 1, max: 4 },
] as unknown as RuntimeManifest["userSettings"];

function manifest(): RuntimeManifest {
  return {
    name: "demo",
    pluginId: "demo",
    userSettings: specs,
  } as RuntimeManifest;
}

describe("resolveUserSettings — constraint enforcement", () => {
  it("keeps valid values and fills the rest from defaults", () => {
    const r = resolveUserSettings(manifest(), {
      demo: { ratio: 80, mode: "short" },
    });
    expect(r).toEqual({ ratio: 80, mode: "short", on: true, count: 2 });
  });

  it("falls back to default for an out-of-range number", () => {
    const r = resolveUserSettings(manifest(), { demo: { ratio: 999 } });
    expect(r?.ratio).toBe(70);
  });

  it("falls back to default for a wrong-type value", () => {
    const r = resolveUserSettings(manifest(), {
      demo: { ratio: "lots", on: "yes" },
    });
    expect(r?.ratio).toBe(70);
    expect(r?.on).toBe(true);
  });

  it("falls back to default for an unlisted select option", () => {
    const r = resolveUserSettings(manifest(), { demo: { mode: "epic" } });
    expect(r?.mode).toBe("medium");
  });

  it("rejects a non-integer for an integer spec", () => {
    const r = resolveUserSettings(manifest(), { demo: { count: 2.5 } });
    expect(r?.count).toBe(2);
  });

  it("uses all defaults when no values are provided", () => {
    const r = resolveUserSettings(manifest(), undefined);
    expect(r).toEqual({ ratio: 70, mode: "medium", on: true, count: 2 });
  });
});
