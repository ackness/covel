import { describe, expect, it } from "vitest";
import type { WorldRecord } from "@/services/api.js";
import {
  worldVisual,
  worldVisualForId,
  worldVisualForTags,
} from "../world-visuals.js";

function makeWorld(overrides: Partial<WorldRecord>): WorldRecord {
  return {
    id: "test-world",
    name: "Test",
    description: "Test world",
    createdAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("world visuals", () => {
  it("matches bundled worlds by id", () => {
    expect(worldVisualForId("emberback")?.image).toBe(
      "/visuals/worlds/emberback.webp",
    );
    expect(worldVisualForId("mistport")?.image).toBe(
      "/visuals/worlds/mistport.webp",
    );
    expect(worldVisual(makeWorld({ id: "neonridge" })).image).toBe(
      "/visuals/worlds/neonridge.webp",
    );
  });

  it("falls back to the first matching tag", () => {
    expect(worldVisualForTags(["romance"])?.image).toBe(
      "/visuals/worlds/haruka-academy.webp",
    );
    expect(worldVisual(makeWorld({ tags: ["custom", "xianxia"] })).image).toBe(
      "/visuals/worlds/cloudmere.webp",
    );
  });

  it("uses the studio background when no world signal matches", () => {
    expect(worldVisual(makeWorld({ tags: ["unknown"] })).image).toBe(
      "/visuals/backgrounds/studio-shell.webp",
    );
  });
});
