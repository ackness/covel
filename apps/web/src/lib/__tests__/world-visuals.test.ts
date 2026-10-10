// @vitest-environment node
import { describe, expect, it } from "vitest";
import type { WorldRecord } from "@/services/api.js";
import { worldCoverRef, worldVisual } from "../world-visuals.js";

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
  it("shows the cover and accent the world declares", () => {
    const visual = worldVisual(
      makeWorld({
        metadata: {
          cover: "media/gallery/world-cover.webp",
          accentColor: "#c9a24b",
        },
      }),
    );
    expect(visual.image).toBe(
      "/api/worlds/test-world/gallery/gallery/world-cover.webp",
    );
    expect(visual.accent).toBe("#c9a24b");
  });

  it("uses the studio background and a stable hue for a world that declares nothing", () => {
    const first = worldVisual(makeWorld({ tags: ["romance"] }));
    expect(first.image).toBe("/visuals/backgrounds/studio-shell.webp");
    expect(first.accent).toMatch(/^oklch\(72% 0\.12 \d+\)$/);
    expect(worldVisual(makeWorld({})).accent).toBe(first.accent);
    expect(worldVisual(makeWorld({ id: "other-world" })).accent).not.toBe(
      first.accent,
    );
  });

  it("ignores a cover path or accent it cannot use", () => {
    const world = makeWorld({
      metadata: { cover: "../secret.png", accentColor: "red; background: x" },
    });
    expect(worldCoverRef(world)).toBeNull();
    expect(worldVisual(world).image).toBe(
      "/visuals/backgrounds/studio-shell.webp",
    );
    expect(worldVisual(world).accent).toMatch(/^oklch\(/);
  });
});
