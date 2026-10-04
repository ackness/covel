import { getPendingProposals } from "@covel/plugin-handlers-utils";
import { describe, expect, it } from "vitest";
import { selectTrack } from "../lib/soundtrack.js";
import cue from "../runtimes/cue/handler.js";
import scene from "../runtimes/scene/handler.js";
import register from "../server/index.js";

const audio = (id) => ({
  id: id.repeat(64).slice(0, 64),
  mime: "audio/mpeg",
  size: 2048,
});

const TRACKS = [
  {
    id: "tavern-brawl",
    file: "brawl.mp3",
    scenes: ["歪角鹿酒馆"],
    moods: ["battle"],
  },
  { id: "battle", file: "battle.mp3", moods: ["battle", "tense"], volume: 0.8 },
  {
    id: "tavern",
    title: "歪角鹿酒馆",
    file: "tavern.mp3",
    scenes: ["歪角鹿酒馆"],
  },
  { id: "theme", title: "提灯古冢", file: "theme.mp3", theme: true },
  { id: "sting", file: "sting.mp3", moods: ["triumph"], loop: false },
];
const REGISTRY = {
  schemaVersion: 1,
  registryId: "music-registry",
  tracks: TRACKS,
};

describe("choosing a track", () => {
  const pick = (facts) => selectTrack(TRACKS, facts)?.id ?? null;

  it("plays the theme of the world before anything is known", () => {
    expect(pick({})).toBe("theme");
  });

  it("plays the scene's own track there, by name or by part of the name", () => {
    expect(pick({ scene: "歪角鹿酒馆" })).toBe("tavern");
    expect(pick({ scene: "歪角鹿酒馆 · 吧台" })).toBe("tavern");
    expect(pick({ scene: "北山墓道" })).toBe("theme");
  });

  it("answers the mood, with the track of this scene first", () => {
    expect(pick({ mood: "battle", scene: "北山墓道" })).toBe("battle");
    expect(pick({ mood: "battle", scene: "歪角鹿酒馆" })).toBe("tavern-brawl");
    expect(pick({ mood: "tense" })).toBe("battle");
  });

  it("keeps the scene's track for a mood no track answers", () => {
    expect(pick({ mood: "sorrow", scene: "歪角鹿酒馆" })).toBe("tavern");
    expect(pick({ mood: "sorrow" })).toBe("theme");
  });

  it("is silent on a silence cue, and without a theme when nothing fits", () => {
    expect(pick({ mood: "silence", scene: "歪角鹿酒馆" })).toBe(null);
    expect(selectTrack([TRACKS[1]], { mood: "calm" })).toBe(null);
  });
});

function handlerCtx({ topic, data, registry = REGISTRY, state = {} }) {
  return {
    sessionId: "s1",
    pluginId: "soundtrack",
    runtimeId: "soundtrack/test",
    turnId: "turn-1",
    triggerEvent: { topic, data },
    pluginData: {
      get: async (namespace, key) =>
        namespace === "tracks" ? registry : (state[key] ?? null),
    },
  };
}
const written = (result) =>
  getPendingProposals(result).map((proposal) => proposal.payload);

describe("recording the mood and the scene", () => {
  it("records a mood, and writes nothing when it repeats", async () => {
    const result = await cue(
      handlerCtx({ topic: "music.cue", data: { mood: "battle" } }),
    );
    expect(written(result)).toEqual([
      {
        namespace: "state",
        key: "mood",
        value: { mood: "battle", turnId: "turn-1" },
      },
    ]);

    const repeated = await cue(
      handlerCtx({
        topic: "music.cue",
        data: { mood: "battle" },
        state: { mood: { mood: "battle" } },
      }),
    );
    expect(repeated.value).toMatchObject({ skipped: true });
    expect(written(repeated)).toEqual([]);
  });

  it("records a scene under its own key", async () => {
    const result = await scene(
      handlerCtx({
        topic: "scene.set",
        data: { location: " 歪角鹿酒馆 ", timeOfDay: "night" },
      }),
    );
    expect(written(result)).toEqual([
      {
        namespace: "state",
        key: "scene",
        value: { name: "歪角鹿酒馆", turnId: "turn-1" },
      },
    ]);
  });

  it("writes nothing for a world without a track list or a payload it cannot use", async () => {
    for (const result of [
      await cue(
        handlerCtx({
          topic: "music.cue",
          data: { mood: "battle" },
          registry: null,
        }),
      ),
      await scene(
        handlerCtx({
          topic: "scene.set",
          data: { location: "酒馆" },
          registry: { tracks: [] },
        }),
      ),
      await cue(handlerCtx({ topic: "music.cue", data: {} })),
      await scene(handlerCtx({ topic: "scene.set", data: { location: " " } })),
    ]) {
      expect(result).toMatchObject({
        outcome: "success",
        value: { skipped: true },
      });
      expect(written(result)).toEqual([]);
    }
  });
});

describe("the stage.music@1 projection", () => {
  const handlers = new Map();
  register({
    provideExtension: (_point, id, { handler }) => handlers.set(id, handler),
  });
  const project = (data, events = [], previous = null) =>
    handlers.get("music")(
      { previous, events },
      {
        pluginData: {
          get: async (namespace, key) =>
            data[`${namespace}/${key}`]
              ? { value: data[`${namespace}/${key}`] }
              : null,
        },
      },
    );
  const WORLD = {
    "tracks/music-registry": REGISTRY,
    "assets/theme.mp3": { ref: audio("a"), filename: "theme.mp3" },
    "assets/tavern.mp3": { ref: audio("b"), filename: "tavern.mp3" },
    "assets/battle.mp3": { ref: audio("c"), filename: "battle.mp3" },
    "assets/sting.mp3": { ref: audio("d"), filename: "sting.mp3" },
  };

  it("opens on the theme and follows the recorded scene and mood", async () => {
    expect(await project(WORLD)).toEqual({
      trackId: "theme",
      title: "提灯古冢",
      ref: audio("a"),
    });
    expect(
      await project({ ...WORLD, "state/scene": { name: "歪角鹿酒馆" } }),
    ).toMatchObject({ trackId: "tavern", ref: audio("b") });
    expect(
      await project({
        ...WORLD,
        "state/scene": { name: "北山墓道" },
        "state/mood": { mood: "battle" },
      }),
    ).toEqual({ trackId: "battle", ref: audio("c"), volume: 0.8 });
  });

  it("follows the events of the turn in progress before they commit", async () => {
    const value = await project(
      { ...WORLD, "state/mood": { mood: "battle" } },
      [
        { topic: "music.cue", turnId: "t2", data: { mood: "triumph" } },
        { topic: "scene.set", turnId: "t2", data: { location: "歪角鹿酒馆" } },
      ],
    );
    expect(value).toEqual({ trackId: "sting", ref: audio("d"), loop: false });
  });

  it("is silent for a silence cue and for a track whose file is missing", async () => {
    expect(
      await project({ ...WORLD, "state/mood": { mood: "silence" } }),
    ).toEqual({});
    expect(
      await project({
        "tracks/music-registry": REGISTRY,
        "assets/theme.mp3": {
          ref: { id: "e".repeat(64), mime: "image/png", size: 1 },
        },
      }),
    ).toEqual({});
  });

  it("leaves the slot to other providers when the world ships no tracks", async () => {
    const previous = { trackId: "other", ref: audio("f") };
    expect(await project({}, [], previous)).toBe(previous);
  });
});
