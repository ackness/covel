import { getPendingProposals } from "@covel/plugin-handlers-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import storyCues from "../runtimes/story-cues/handler.js";
import register from "../server/index.js";
const handlers = new Map();
let dispose;
beforeEach(() => {
  handlers.clear();
  register({
    onDispose: (cleanup) => {
      dispose = cleanup;
    },
    provideExtension: (_point, id, { handler }) => handlers.set(id, handler),
  });
});
afterEach(() => {
  dispose();
  vi.useRealTimers();
});
const ref = { id: "a".repeat(64), mime: "image/png", size: 1 };
const context = (data, sessionId = "stage-projection") => ({
  sessionId,
  world: { characters: [{ id: "session-hero", name: "Hero" }] },
  pluginData: {
    get: async (namespace, key) => data[`${namespace}/${key}`] ?? null,
    list: async (namespace) =>
      Object.entries(data)
        .filter(([key]) => key.startsWith(`${namespace}/`))
        .map(([key, value]) => ({ key, value, updatedAt: "2026-01-01" })),
  },
});
describe("stage UI projections", () => {
  const oldActor = { characterId: "rin", displayName: "Rin", active: true };
  const sceneEvent = {
    topic: "scene.set",
    data: { location: "Library" },
    turnId: "new",
  };
  const actorEvent = {
    topic: "stage.direction",
    data: { cues: [{ type: "actor.enter", character: "Hero", focus: true }] },
    turnId: "new",
  };
  const scenes = {
    "stage/current": { sceneId: "classroom", name: "Classroom", turnId: "old" },
    "scenes/scene-registry": {
      scenes: [{ sceneId: "library", name: "Library" }],
    },
    "direction/current": { actors: [oldActor], turnId: "old" },
  };

  it("fades a presence departure in projection while storing only the present actors", async () => {
    vi.useFakeTimers();
    const departed = {
      characterId: "lin",
      displayName: "Lin",
      active: false,
      position: "right",
      visual: { outfit: "uniform" },
      transition: "slide-right",
    };
    const current = {
      actors: [
        { characterId: "session-hero", displayName: "Hero", active: true },
        departed,
      ],
      turnId: "old",
    };
    const data = { "direction/current": current };
    const ctx = context(data);
    ctx.world.characters.push({ id: "lin", name: "Lin" });
    const project = (events = []) =>
      handlers.get("direction")({ previous: null, events }, ctx);
    await project();
    const result = await storyCues({
      ...ctx,
      pluginId: "scene-stage",
      runtimeId: "scene-stage/story-cues",
      turnId: "new",
      inputs: {
        story: {
          cardinality: "one",
          value: { cues: { present: ["Hero"] } },
          source: {
            pluginId: "story-fixture",
            runtimeId: "story-fixture",
            resultId: "story-result",
          },
        },
      },
    });
    const direction = getPendingProposals(result).find(
      ({ payload }) => payload.namespace === "direction",
    ).payload.value;
    expect(direction.actors.map(({ characterId }) => characterId)).toEqual([
      "session-hero",
    ]);
    expect(direction.actors.every((actor) => !actor.exiting)).toBe(true);
    data["direction/current"] = direction;
    const projected = await project();
    expect(projected.actors).toEqual([
      { characterId: "session-hero", displayName: "Hero", active: true },
      { ...departed, exiting: true, transition: "fade" },
    ]);
    expect(await project()).toEqual(projected);
    expect(current.actors).toHaveLength(2);
    vi.advanceTimersByTime(301);
    expect(
      (await project()).actors.map(({ characterId }) => characterId),
    ).toEqual(["session-hero"]);
  });

  it("isolates departure history by session and clears it when the entry is disposed", async () => {
    const data = { "direction/current": { actors: [oldActor], turnId: "old" } };
    const project = (sessionId) =>
      handlers.get("direction")(
        { previous: null, events: [] },
        context(data, sessionId),
      );
    await project("first-session");
    data["direction/current"] = { actors: [], turnId: "new" };
    expect((await project("second-session")).actors).toEqual([]);
    expect((await project("first-session")).actors).toEqual([
      { ...oldActor, active: false, exiting: true, transition: "fade" },
    ]);
    dispose();
    expect((await project("first-session")).actors).toEqual([]);
  });

  it("keeps failed event previews out of committed departure history", async () => {
    const data = { "direction/current": { actors: [oldActor], turnId: "old" } };
    const ctx = context(data);
    const project = (events = []) =>
      handlers.get("direction")({ previous: null, events }, ctx);
    await project();
    expect(
      (
        await project([
          {
            topic: "stage.direction",
            turnId: "failed",
            data: { cues: [{ type: "stage.clear", transition: "fade" }] },
          },
        ])
      ).actors[0].exiting,
    ).toBe(true);
    expect((await project()).actors).toEqual([oldActor]);
    data["direction/current"] = { actors: [], turnId: "new" };
    expect((await project()).actors).toEqual([
      { ...oldActor, active: false, exiting: true, transition: "fade" },
    ]);
  });

  it("does not project the new viewpoint from saved cast selection or departure history", async () => {
    const data = {
      "direction/current": { actors: [oldActor], turnId: "old" },
      "active-cast/current": { speakers: [{ id: "rin", name: "Rin" }] },
    };
    const ctx = context(data);
    ctx.world.characters.push({ id: "rin", name: "Rin", type: "player" });
    ctx.world.seats = [
      {
        id: "primary",
        controller: "human",
        role: "player",
        characters: ["session-hero", "rin"],
        currentCharacterId: "session-hero",
      },
    ];
    await handlers.get("direction")({ previous: null, events: [] }, ctx);
    ctx.world.seats[0].currentCharacterId = "rin";
    const cast = await handlers.get("cast")({}, ctx);
    expect(cast).toEqual({ actors: [], retainWhenEmpty: false });
    const direction = await handlers.get("direction")(
      { previous: cast, events: [] },
      ctx,
    );
    expect(direction.actors).toEqual([]);
    delete data["direction/current"];
    expect(
      await handlers.get("direction")({ previous: cast, events: [] }, ctx),
    ).toEqual(cast);
  });

  it.each([
    [sceneEvent, actorEvent],
    [actorEvent, sceneEvent],
  ])(
    "previews a location reset before new actor cues regardless event order: %j",
    async (...events) => {
      const value = await handlers.get("direction")(
        {
          previous: { actors: [oldActor], retainWhenEmpty: true },
          events,
        },
        context(scenes),
      );
      expect(value).toMatchObject({
        actors: [{ characterId: "session-hero", displayName: "Hero" }],
        retainWhenEmpty: false,
      });
      expect(value.actors).toHaveLength(1);
    },
  );

  it("does not retain the old cast when a location changes without actor cues", async () => {
    expect(
      await handlers.get("direction")(
        {
          previous: { actors: [oldActor], retainWhenEmpty: true },
          events: [sceneEvent],
        },
        context(scenes),
      ),
    ).toEqual({ actors: [], retainWhenEmpty: false });
  });

  it("preserves cast fallback for a world without direction state", async () => {
    const { "direction/current": _direction, ...withoutDirection } = scenes;
    const previous = { actors: [oldActor], retainWhenEmpty: true };
    expect(
      await handlers.get("direction")(
        { previous, events: [sceneEvent] },
        context(withoutDirection),
      ),
    ).toBe(previous);
  });

  it.each([
    [sceneEvent, actorEvent],
    [actorEvent, sceneEvent],
  ])(
    "starts a first direction preview from an empty cast: %j",
    async (...events) => {
      const { "direction/current": _direction, ...withoutDirection } = scenes;
      const value = await handlers.get("direction")(
        {
          previous: { actors: [oldActor], retainWhenEmpty: true },
          events,
        },
        context(withoutDirection),
      );
      expect(value.actors.map(({ characterId }) => characterId)).toEqual([
        "session-hero",
      ]);
      expect(value.retainWhenEmpty).toBe(false);
    },
  );

  it("keeps fallback when a first focus-only cue cannot establish direction", async () => {
    const previous = { actors: [oldActor], retainWhenEmpty: true };
    const { "direction/current": _direction, ...withoutDirection } = scenes;
    expect(
      await handlers.get("direction")(
        {
          previous,
          events: [
            {
              topic: "stage.direction",
              turnId: "new",
              data: { cues: [{ type: "actor.focus", character: "Hero" }] },
            },
          ],
        },
        context(withoutDirection),
      ),
    ).toBe(previous);
  });

  it("projects resolved imagery and preloads a registry without an active scene", async () => {
    expect(
      await handlers.get("backdrop")(
        { events: [] },
        context({
          "scenes/scene-registry": { scenes: [{ sceneId: "gate", day: ref }] },
        }),
      ),
    ).toEqual({ preload: [ref] });
  });
  it("provides no dialogue slot: nameplates come from story segments", () => {
    expect(handlers.has("dialogue")).toBe(false);
  });

  it("ignores viewpoint actor cues in the preview just as the direction handler does", async () => {
    const ctx = context(scenes);
    ctx.world.characters.push({ id: "player", name: "Player", type: "npc" });
    ctx.world.seats = [
      {
        id: "primary",
        controller: "human",
        role: "player",
        characters: ["player"],
        currentCharacterId: "player",
      },
    ];
    const value = await handlers.get("direction")(
      {
        previous: { actors: [oldActor], retainWhenEmpty: true },
        events: [
          sceneEvent,
          {
            topic: "stage.direction",
            turnId: "new",
            data: {
              cues: [
                { type: "actor.enter", character: "Player", focus: true },
                { type: "actor.enter", character: "Hero", focus: true },
              ],
            },
          },
        ],
      },
      ctx,
    );
    expect(value.actors.map(({ characterId }) => characterId)).toEqual([
      "session-hero",
    ]);
  });

  it("allows a first explicit stage.clear to clear fallback actors", async () => {
    expect(
      await handlers.get("direction")(
        {
          previous: { actors: [oldActor], retainWhenEmpty: true },
          events: [
            {
              topic: "stage.direction",
              turnId: "new",
              data: { cues: [{ type: "stage.clear" }] },
            },
          ],
        },
        context({}),
      ),
    ).toEqual({ actors: [], retainWhenEmpty: false });
  });
  it("lets an explicit empty direction clear an earlier cast provider", async () => {
    const value = await handlers.get("direction")(
      {
        previous: {
          actors: [{ characterId: "session-hero", displayName: "Hero" }],
          retainWhenEmpty: true,
        },
        events: [],
      },
      context({ "direction/current": { actors: [], schemaVersion: 1 } }),
    );
    expect(value).toEqual({ actors: [], retainWhenEmpty: false });
  });
});
