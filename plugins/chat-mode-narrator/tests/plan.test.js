import { describe, expect, it, vi } from "vitest";
import { makeManualFunctionContext } from "@covel/plugin-test-utils";
import handler from "../runtimes/plan/handler.js";

const characters = [
  { id: "a", name: "Mara", type: "npc", aliases: ["Captain"] },
  { id: "b", name: "Ivo", type: "npc" },
  { id: "human-a", name: "Human One", type: "player" },
  { id: "human-b", name: "Human Two", type: "npc" },
  { id: "unbound", name: "Free Player", type: "player" },
];
const seats = [
  {
    id: "human",
    controller: "human",
    role: "player",
    characters: ["human-a", "human-b"],
  },
];
function context(overrides = {}) {
  return makeManualFunctionContext({
    pluginId: "chat-mode-narrator",
    playerActions: [],
    world: { characters, seats },
    signal: new AbortController().signal,
    ...overrides,
  });
}
const slot = (value) => ({ cardinality: "one", value });
const advice = {
  order: "sequential",
  narrator: "after",
  yieldHint: "continue",
};
describe("dialogue policy preparation", () => {
  it("calls the contract once with structured stage presence and excludes all human bindings", async () => {
    const call = vi.fn(async ({ input }) => ({
      ...advice,
      actors: input.present.map(({ characterId }) => ({ characterId })),
    }));
    const actions = [
      { kind: "direct", source: "player", seatId: "human", text: "Listen." },
    ];
    const ctx = context({
      playerActions: actions,
      services: { call },
      inputs: {
        "active-cast": slot({
          speakers: characters.map(({ id, name }) => ({ id, name })),
          activeCastContext: "SECRET-STAGE-ROUTING",
        }),
      },
    });
    const result = await handler(ctx);
    expect(call).toHaveBeenCalledOnce();
    expect(call.mock.calls[0][0]).toEqual({
      contract: "turn-policy@1",
      input: {
        actions,
        present: [
          { characterId: "a", name: "Mara" },
          { characterId: "b", name: "Ivo" },
          { characterId: "unbound", name: "Free Player" },
        ],
        recentSegments: [],
      },
    });
    expect(result.value.actors.map(({ character }) => character)).toEqual([
      "Mara",
      "Ivo",
      "Free Player",
    ]);
    expect(JSON.stringify(result)).not.toMatch(
      /SECRET-STAGE-ROUTING|characterId|human-a|human-b/,
    );
  });
  it("honors an explicit empty stage and empty committed presence", async () => {
    const previous = {
      segments: [{ kind: "dialogue", speaker: "Mara", text: "Welcome." }],
      cues: { present: [] },
    };
    const call = vi.fn(async () => ({ ...advice, actors: [] }));
    for (const overrides of [
      {
        inputs: { "active-cast": slot({ speakers: [] }) },
        playerActions: [{ kind: "direct", text: "Ivo" }],
      },
      { exports: { previous: slot(previous) } },
      {},
    ]) {
      const result = await handler(
        context({ services: { call }, ...overrides }),
      );
      expect(result.value.cast).toEqual([]);
      expect(result.value.yieldHint).toBe("user");
    }
  });
  it("uses prior public names and deliberate current introductions without stage data", async () => {
    const call = vi.fn(async () => ({ ...advice, actors: [] }));
    const previous = {
      segments: [{ kind: "dialogue", speaker: "Mara", text: "Welcome." }],
      cues: { present: ["Captain"] },
      intent: "PRIVATE-STORY-EXTRA",
    };
    const result = await handler(
      context({
        services: { call },
        exports: { previous: slot(previous) },
        playerActions: [
          { kind: "turn-policy/choose-actors", fields: { actors: "Ivo" } },
        ],
      }),
    );
    expect(result.value.cast).toEqual(["Mara", "Ivo"]);
    expect(call.mock.calls[0][0].input.recentSegments).toEqual(
      previous.segments,
    );
    expect(JSON.stringify(result)).not.toContain("PRIVATE-STORY-EXTRA");
  });
  it.each([
    undefined,
    new Error("PRIVATE-PROVIDER-EXCEPTION"),
    { code: "invalid-input", hint: "invalid-selection" },
    { code: "invalid-input" },
  ])(
    "returns a safe optional fallback for unavailable policy calls",
    async (error) => {
      const result = await handler(
        context({
          playerActions: [{ kind: "direct", text: "Mara" }],
          ...(error
            ? {
                services: {
                  call: async () => {
                    throw error;
                  },
                },
              }
            : {}),
        }),
      );
      expect(result.value).toMatchObject({
        status:
          error?.hint === "invalid-selection"
            ? "invalid-selection"
            : "unavailable",
        cast: ["Mara"],
        actors: [],
        yieldHint: "user",
      });
      expect(JSON.stringify(result)).not.toContain(
        "PRIVATE-PROVIDER-EXCEPTION",
      );
    },
  );
  it("propagates parent cancellation and never publishes a late plan", async () => {
    const controller = new AbortController();
    await expect(
      handler(
        context({
          signal: controller.signal,
          services: {
            call: async () => {
              controller.abort();
              throw new Error("Stopped");
            },
          },
        }),
      ),
    ).rejects.toThrow();
  });
});
