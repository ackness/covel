import { describe, expect, it, vi } from "vitest";
import { chooseActors } from "../lib/policies.js";
import { characters, context, input } from "./fixture.js";
const call = (request, settings = {}, overrides = {}) =>
  chooseActors(input(request), context(settings, overrides), "turn-policy");
const ids = (plan) => plan.actors.map(({ characterId }) => characterId);
describe("policy strategies", () => {
  it("matches actions, aliases and the last public segment without overlapping names", async () => {
    expect(
      ids(
        await call({
          actions: [{ text: "Captain, greet Vice President Shiraishi." }],
        }),
      ),
    ).toEqual(["mara", "vice"]);
    expect(
      ids(
        await call({
          recentSegments: [
            { kind: "dialogue", speaker: "Ivo", text: "Good evening." },
          ],
        }),
      ),
    ).toEqual(["ivo"]);
    expect(
      ids(
        await call({
          recentSegments: [
            { kind: "action", text: "Mara waits." },
            { kind: "narration", text: "Silence." },
          ],
        }),
      ),
    ).toEqual([]);
    expect((await call({})).yieldHint).toBe("user");
  });
  it("orders a fixed pass and skips known absent characters", async () => {
    const plan = await call(
      {
        actions: [
          {
            kind: "direct",
            source: "player",
            seatId: "host-seat",
            text: "Talk.",
          },
        ],
      },
      { strategy: "list", actorOrder: "Ivo\nAbsent\nCaptain\nIvo" },
    );
    expect(ids(plan)).toEqual(["ivo", "mara", "president", "vice"]);
    expect(plan).toMatchObject({
      order: "sequential",
      narrator: "after",
      yieldHint: "continue",
    });
    expect(ids(await call({}, { strategy: "list" }))).toEqual([
      "mara",
      "ivo",
      "president",
      "vice",
    ]);
    await expect(
      call({}, { strategy: "list", actorOrder: "Nobody" }),
    ).rejects.toMatchObject({ code: "invalid-input" });
    await expect(
      call(
        {},
        { strategy: "list", actorOrder: "Keeper" },
        {
          world: {
            characters: [
              ...characters,
              { id: "another", name: "Other", aliases: ["Keeper"] },
            ],
            seats: [],
          },
        },
      ),
    ).rejects.toMatchObject({ code: "invalid-input" });
  });
  it("samples without replacement, excluding only current action actors", async () => {
    const request = {
      actions: [{ kind: "say", source: "player", actorId: "mara" }],
      recentSegments: [{ kind: "dialogue", speaker: "Ivo", text: "Earlier." }],
    };
    const first = await call(request, { strategy: "random" });
    expect(ids(first)).toEqual(
      ids(await call(request, { strategy: "random" })),
    );
    expect(new Set(ids(first)).size).toBe(3);
    expect(ids(first)).toContain("ivo");
    expect(ids(first)).not.toContain("mara");
    expect(first).toMatchObject({ order: "parallel", yieldHint: "user" });
  });
  it.each(["mention", "list", "random", "manual", "director"])(
    "bounds %s and does no work for zero or empty presence",
    async (strategy) => {
      const int = vi.fn(),
        generateObject = vi.fn();
      for (const request of [
        { present: [] },
        { present: [{ characterId: "unknown", name: "Nobody" }] },
        { limits: { maxActors: 0, maxSubagentCalls: 16 } },
        { limits: { maxActors: 4, maxSubagentCalls: 0 } },
      ]) {
        expect(
          await call(
            request,
            { strategy },
            { random: { int }, gateway: { generateObject } },
          ),
        ).toEqual({
          actors: [],
          order: "sequential",
          narrator: "after",
          yieldHint: "user",
        });
      }
      expect(int).not.toHaveBeenCalled();
      expect(generateObject).not.toHaveBeenCalled();
    },
  );
  it("does not mutate inputs or retain prior-round actor exclusions", async () => {
    const request = input({
      actions: [{ kind: "advance", source: "system" }],
      limits: { maxActors: 1, maxSubagentCalls: 1 },
    });
    const before = structuredClone(request);
    const ctx = context({ strategy: "list" });
    expect(ids(await chooseActors(request, ctx, "turn-policy"))).toEqual([
      "mara",
    ]);
    expect(ids(await chooseActors(request, ctx, "turn-policy"))).toEqual([
      "mara",
    ]);
    expect(request).toEqual(before);
    const other = await call(
      { actions: [{ kind: "direct", source: "player", seatId: "outsider" }] },
      { strategy: "list" },
    );
    expect(other.yieldHint).toBe("user");
  });
});
