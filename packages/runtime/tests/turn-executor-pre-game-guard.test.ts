/**
 * Unit tests for retainPreGameRuntimes — the F-1 guard that prevents a
 * PreSchedule hook from dropping Pre-Game runtimes (priority ≤ 99) while
 * Pre-Game is still pending.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import type { RuntimeManifest } from "@covel/shared";
import { retainPreGameRuntimes } from "../src/turn-executor-helpers.js";

function rt(name: string, priority: number): RuntimeManifest {
  return {
    name,
    pluginId: name.split("/")[0] ?? name,
    description: name,
    priority,
    runtimeType: "agent",
  };
}

// Pre-Game band: pregame(10), schema-gen(40), player-init(50). Main loop: 500.
const pregame = rt("pregame", 10);
const schemaGen = rt("world-init/schema-gen", 40);
const playerInit = rt("char-creator/player-init", 50);
const narrator = rt("narrator", 500);

describe("retainPreGameRuntimes", () => {
  afterEach(() => vi.restoreAllMocks());

  it("re-adds a Pre-Game runtime a hook dropped", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const triggered = [pregame, schemaGen, playerInit];
    // Hook tried to drop schema-gen + player-init, keeping only pregame.
    const scheduled = [pregame];

    const result = retainPreGameRuntimes(scheduled, triggered);
    const names = result.map((r) => r.name);

    expect(names).toContain("world-init/schema-gen");
    expect(names).toContain("char-creator/player-init");
    expect(names).toContain("pregame");
    expect(warn).toHaveBeenCalledOnce();
  });

  it("allows dropping main-loop runtimes (priority ≥ 100)", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const triggered = [narrator, rt("guide", 600)];
    // Hook dropped guide — that's allowed (not Pre-Game).
    const scheduled = [narrator];

    const result = retainPreGameRuntimes(scheduled, triggered);

    expect(result.map((r) => r.name)).toEqual(["narrator"]);
    expect(warn).not.toHaveBeenCalled();
  });

  it("retains Pre-Game while still allowing a main-loop drop in the same set", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const triggered = [pregame, schemaGen, narrator];
    // Hook dropped schema-gen (Pre-Game → rescued) AND narrator (main → allowed).
    const scheduled = [pregame];

    const names = retainPreGameRuntimes(scheduled, triggered).map(
      (r) => r.name,
    );

    expect(names).toContain("pregame");
    expect(names).toContain("world-init/schema-gen"); // rescued
    expect(names).not.toContain("narrator"); // main-loop drop honoured
  });

  it("returns the input unchanged when nothing Pre-Game was dropped", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const triggered = [pregame, schemaGen];
    const scheduled = [pregame, schemaGen];

    const result = retainPreGameRuntimes(scheduled, triggered);

    expect(result).toBe(scheduled);
    expect(warn).not.toHaveBeenCalled();
  });
});
