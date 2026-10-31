import { describe, expect, it, vi } from "vitest";
import { createMemoryStore } from "@covel/store/memory";
import {
  materializeWorldModel,
  type Proposal,
  type ProposalFor,
  type RuntimeManifest,
  type RuntimeResult,
} from "@covel/shared";
import { withPendingProposals } from "@covel/tools";
import {
  createWorldModelView,
  snapshotWorldModelView,
  memoizeWorldModelReads,
  overlayWorldModelView,
} from "../src/function-runtime/world-model-view.js";
import { collectUpstreamWorldWrites } from "../src/function-runtime/upstream-world-model.js";
import { attachNestedResults } from "../src/turn-executor/nested-results.js";
import { createCommitPipeline } from "../src/session/session-kernel.js";
import { runTurnPipeline } from "../src/turn-executor/turn-executor.js";

const sessionId = "world-session";
const timestamp = "2026-01-01T00:00:00.000Z";
const base = { characterSchema: null, characters: [] };
function proposal<T extends Proposal["type"]>(
  type: T,
  payload: ProposalFor<T>["payload"],
): ProposalFor<T> {
  return {
    id: crypto.randomUUID(),
    type,
    payload,
    sessionId,
    turnId: "turn",
    source: { pluginId: "producer", runtimeId: "producer/run" },
    timestamp,
  };
}
const schema = () =>
  proposal("character.schema.set", {
    types: ["merchant"],
    attributes: [
      {
        id: "hp",
        name: "HP",
        type: "number",
        min: 0,
        max: 10,
        category: "stats",
      },
    ],
  });
const character = () =>
  proposal("character.upsert", {
    id: "merchant-1",
    name: "Merchant",
    type: "merchant",
    fields: { hp: 5 },
  });

describe("execution World Model", () => {
  it("validates the same ordered schema and character proposals at read and commit", async () => {
    const store = createMemoryStore();
    const pending = [schema(), character()];
    const view = await createWorldModelView(store, sessionId, pending);
    expect(view.characterSchema).toMatchObject({
      version: 1,
      types: ["merchant"],
    });
    expect(view.characters[0]).toMatchObject({
      type: "merchant",
      fields: { hp: 5 },
    });
    expect(await store.getCharacterSchema(sessionId)).toBeNull();
    expect(await store.listCharacters(sessionId)).toEqual([]);
    const committed = await createCommitPipeline(store).commitAll(pending);
    expect(committed.every((result) => result.committed)).toBe(true);
    expect(await store.getCharacterSchema(sessionId)).toEqual(
      view.characterSchema,
    );
    expect(await store.listCharacters(sessionId)).toEqual(view.characters);
  });

  it("adds the aliases of a versioned write to the stored ones and replaces them on an unversioned write", async () => {
    const store = createMemoryStore();
    const pipeline = createCommitPipeline(store);
    const write = (
      payload: Partial<ProposalFor<"character.upsert">["payload"]>,
    ) =>
      proposal("character.upsert", {
        id: "ysolde",
        name: "Keeper Ysolde",
        type: "npc",
        ...payload,
      });
    await pipeline.commitAll([write({ aliases: ["Ysolde", "KEEPER YSOLDE"] })]);
    await pipeline.commitAll([
      write({ aliases: ["the Keeper", "ysolde"], expectedVersion: 1 }),
    ]);
    expect(await store.listCharacters(sessionId)).toMatchObject([
      { aliases: ["Ysolde", "the Keeper"], version: 2 },
    ]);
    await pipeline.commitAll([write({ fields: {}, expectedVersion: 2 })]);
    expect((await store.listCharacters(sessionId))[0]!.aliases).toEqual([
      "Ysolde",
      "the Keeper",
    ]);
    await pipeline.commitAll([write({})]);
    expect((await store.listCharacters(sessionId))[0]!.aliases).toBeUndefined();
  });

  it("rejects, at read and at commit, an alias that another character has as a name or an alias", async () => {
    const store = createMemoryStore();
    const pipeline = createCommitPipeline(store);
    await pipeline.commitAll([
      proposal("character.upsert", {
        id: "ysolde",
        name: "Keeper Ysolde",
        type: "npc",
        aliases: ["the Keeper"],
      }),
    ]);
    for (const alias of ["THE KEEPER", "keeper ysolde"]) {
      const clash = proposal("character.upsert", {
        id: "maud",
        name: "Maud",
        type: "npc",
        aliases: [alias],
      });
      await expect(
        createWorldModelView(store, sessionId, [clash]),
      ).rejects.toThrow(
        `Alias "${alias}" of Maud [maud] is already a name of Keeper Ysolde (aka the Keeper) [ysolde]`,
      );
      const [result] = await pipeline.commitAll([clash]);
      expect(result).toMatchObject({ committed: false });
    }
    expect(
      (await store.listCharacters(sessionId)).map((record) => record.id),
    ).toEqual(["ysolde"]);
  });

  it("reads own buffered writes without exposing mutable records or live store changes", async () => {
    const store = createMemoryStore();
    const pending: Proposal[] = [];
    const view = await createWorldModelView(
      store,
      sessionId,
      [schema()],
      pending,
    );
    pending.push(character());
    const first = view.characters;
    // A read is a frozen copy: a reader cannot change what the next one sees.
    expect(() => {
      (first[0]!.fields as { hp: number }).hp = 100;
    }).toThrow(TypeError);
    expect(view.characters[0]!.fields).toEqual({ hp: 5 });
    // The copy is made once and returned until the buffer grows.
    expect(view.characters).toBe(first);
    const firstSchema = view.characterSchema!;
    expect(() => (firstSchema.types as string[]).push("mutated")).toThrow(
      TypeError,
    );
    expect(view.characterSchema!.types).toEqual(["merchant"]);
    pending.push(character());
    expect(view.characters).not.toBe(first);
    await store.upsertCharacterSchema({
      ...firstSchema,
      version: 100,
      types: ["other"],
    });
    expect(view.characterSchema!.version).toBe(1);
  });

  it("refuses one alias for two characters of a batch, and a name that is another's alias", () => {
    const npc = (id: string, name: string, aliases?: string[]) =>
      proposal("character.upsert", {
        id,
        name,
        type: "npc",
        ...(aliases ? { aliases } : {}),
      });
    expect(() =>
      materializeWorldModel(
        base,
        [npc("a", "Anna", ["the Captain"]), npc("b", "Bram", ["THE captain"])],
        sessionId,
      ),
    ).toThrow(
      'Alias "THE captain" of Bram [b] is already a name of Anna (aka the Captain) [a]',
    );
    expect(() =>
      materializeWorldModel(
        base,
        [npc("a", "Anna", ["Annie"]), npc("b", "annie")],
        sessionId,
      ),
    ).toThrow('Name "annie" of [b] is an alias of Anna (aka Annie) [a]');
    // Two characters may share a name; a character may repeat its own.
    expect(
      materializeWorldModel(
        base,
        [npc("a", "Anna", ["Annie"]), npc("b", "Anna"), npc("a", "Anna")],
        sessionId,
      ).characters.map((record) => record.id),
    ).toEqual(["b", "a"]);
  });

  it("reads a buffer that grew, was replaced, or was emptied as it is now", () => {
    const write = (id: string, hp: number) =>
      proposal("character.upsert", {
        id,
        name: id,
        type: "npc",
        fields: { hp },
      });
    const pending: Proposal[] = [write("a", 1)];
    const view = overlayWorldModelView(
      { ...base, dimensions: {}, seats: [] },
      sessionId,
      pending,
    );
    const read = () =>
      view.characters.map((record) => [
        record.id,
        (record.fields as { hp: number }).hp,
      ]);
    expect(read()).toEqual([["a", 1]]);
    pending.push(write("b", 2));
    expect(read()).toEqual([
      ["a", 1],
      ["b", 2],
    ]);
    // Same length, another proposal in the last place.
    pending[1] = write("c", 3);
    expect(read()).toEqual([
      ["a", 1],
      ["c", 3],
    ]);
    pending.length = 0;
    expect(read()).toEqual([]);
    // A write that is refused is refused again at the next read, and the
    // model is as before once it has left the buffer.
    pending.push(
      write("a", 1),
      proposal("character.upsert", { id: "d", name: "D", type: "undeclared" }),
    );
    expect(read).toThrow("Unknown character type");
    expect(read).toThrow("Unknown character type");
    pending.pop();
    expect(read()).toEqual([["a", 1]]);
  });

  it.each([
    [
      "range",
      () => [
        schema(),
        proposal("character.upsert", {
          ...character().payload,
          fields: { hp: 11 },
        }),
      ],
    ],
    [
      "type",
      () => [
        schema(),
        proposal("character.upsert", {
          ...character().payload,
          type: "undeclared",
        }),
      ],
    ],
    [
      "invalid expected version",
      () => [
        schema(),
        character(),
        proposal("character.upsert", {
          ...character().payload,
          expectedVersion: 4,
        }),
      ],
    ],
  ] as const)(
    "rejects %s consistently before exposing or committing invalid data",
    async (_name, proposals) => {
      const pending = proposals();
      expect(() => materializeWorldModel(base, pending, sessionId)).toThrow();
      const store = createMemoryStore();
      const committed = await createCommitPipeline(store).commitAll(pending);
      expect(committed.some((result) => !result.committed)).toBe(true);
      const stored = await store.listCharacters(sessionId);
      expect(stored.every((record) => record.type !== "undeclared")).toBe(true);
      expect(
        stored.every(
          (record) =>
            !record.fields || (record.fields as { hp?: number }).hp !== 11,
        ),
      ).toBe(true);
    },
  );

  it("accepts a second player character at read and commit", async () => {
    const pending = [
      proposal("character.upsert", { id: "one", name: "One", type: "player" }),
      proposal("character.upsert", { id: "two", name: "Two", type: "player" }),
    ];
    expect(
      materializeWorldModel(base, pending, sessionId).characters.map(
        (record) => record.id,
      ),
    ).toEqual(["one", "two"]);
    const store = createMemoryStore();
    const committed = await createCommitPipeline(store).commitAll(pending);
    expect(committed.every((result) => result.committed)).toBe(true);
    expect(
      (await store.listCharacters(sessionId)).filter(
        (record) => record.type === "player",
      ),
    ).toHaveLength(2);
  });

  it("ignores failed/suspended results and rebinds completed proposal identity like commit", () => {
    const result = (status: RuntimeResult["status"]): RuntimeResult => ({
      pluginId: "actual",
      runtimeId: "actual/run",
      turnId: "actual-turn",
      runId: "actual-run",
      status,
      output: {},
      toolCalls: [],
      durationMs: 0,
      timestamp: "2026-01-01T00:00:00.000Z",
      pendingProposals: [{ ...schema(), sessionId: "forged" }],
    });
    const collected = collectUpstreamWorldWrites(
      new Map([
        ["failed", result("failed")],
        ["success", result("success")],
        ["skipped", result("skipped")],
      ]),
      sessionId,
    );
    expect(collected).toHaveLength(2);
    expect(collected[0]?.proposal).toMatchObject({
      sessionId,
      turnId: "actual-turn",
      source: { pluginId: "actual", runtimeId: "actual/run" },
    });
  });

  it("shares committed reads while isolating each handler world view", async () => {
    const store = createMemoryStore();
    await createCommitPipeline(store).commitAll([schema(), character()]);
    let characterReads = 0;
    const counted = {
      ...store,
      listCharacters: (id: string) => {
        characterReads += 1;
        return store.listCharacters(id);
      },
    } as typeof store;
    const reads = memoizeWorldModelReads(counted);
    const first = await createWorldModelView(reads, sessionId);
    const firstCharacters = await reads.listCharacters(sessionId);
    expect(await reads.listCharacters(sessionId)).toBe(firstCharacters);
    expect(() => {
      (first.characters[0]!.fields as { hp: number }).hp = 0;
    }).toThrow();
    expect(first.characters).not.toBe(firstCharacters);
    expect(Object.isFrozen(firstCharacters[0]!.fields)).toBe(false);
    const second = await createWorldModelView(reads, sessionId);
    expect(characterReads).toBe(1);
    expect(second.characters).toEqual(first.characters);
    expect(second.characters[0]?.fields).toEqual({ hp: 5 });
  });

  it("reads characters without copying the world record again", () => {
    const view = overlayWorldModelView(
      {
        characterSchema: null,
        characters: [],
        dimensions: {},
        worldRecord: { id: "world", name: "World", description: "long lore" },
      } as never,
      sessionId,
    );
    const clone = vi.spyOn(globalThis, "structuredClone");
    try {
      expect(view.characters).toEqual([]);
      expect(view.dimensions).toEqual({});
      expect(JSON.stringify(clone.mock.calls)).not.toContain("long lore");
      expect(view.worldRecord).toMatchObject({ description: "long lore" });
    } finally {
      clone.mockRestore();
    }
  });

  it("makes upstream schema and character output visible across a single scheduled execution", async () => {
    const store = createMemoryStore();
    await store.appendTurnMessage({
      id: "seed",
      sessionId,
      turnId: "seed",
      sourceType: "player",
      role: "user",
      content: "start",
      order: 0,
      createdAt: timestamp,
    });
    const manifests: RuntimeManifest[] = [
      "schema",
      "character",
      "consumer",
    ].map((name, index) => ({
      name: `provider/${name}`,
      pluginId: "provider",
      description: name,
      stage: "pre-turn",
      runtimeType: "function",
      handler: "./handler.js",
      trigger: { type: "auto" },
      ...(index > 0
        ? {
            inputs: {
              upstream: {
                from: {
                  runtime: `provider/${index === 1 ? "schema" : "character"}`,
                },
              },
            },
          }
        : {}),
    }));
    const seen: unknown[] = [];
    const result = await runTurnPipeline(
      { origin: "player", sessionId, turnId: "turn", playerMessage: "go" },
      manifests,
      {
        store,
        llm: {
          generate: async () => {
            throw new Error("Function runtimes do not use the LLM");
          },
        },
        loadRuntime: async (manifest) => ({
          manifest,
          promptTemplate: "",
          handler: async (ctx) => {
            if (manifest.name.endsWith("/schema"))
              return withPendingProposals(
                { outcome: "success", value: { ready: true } },
                [schema()],
              );
            if (manifest.name.endsWith("/character")) {
              expect(ctx.world?.characterSchema?.types).toEqual(["merchant"]);
              return withPendingProposals(
                { outcome: "success", value: { ready: true } },
                [character()],
              );
            }
            seen.push(ctx.world?.characters[0]?.fields);
            return { outcome: "success", value: { ready: true } };
          },
        }),
      },
    );
    expect(
      result.runtimeResults.map((entry) => [
        entry.runtimeId,
        entry.status,
        entry.error,
      ]),
    ).toEqual(
      manifests.map((manifest) => [manifest.name, "success", undefined]),
    );
    expect(seen).toEqual([{ hp: 5 }]);
    expect(await store.listCharacters(sessionId)).toEqual([]);
  });
});

describe("seats in the execution view", () => {
  it("reads the session's seats, frozen, and keeps them through own-write overlays", async () => {
    const store = createMemoryStore();
    const seats = [
      {
        id: "main",
        controller: "human" as const,
        role: "player" as const,
        characters: "auto" as const,
        currentCharacterId: "merchant-1",
      },
    ];
    await store.createSession({
      id: sessionId,
      status: "active",
      phase: "playing",
      completedPlayerTurns: 0,
      setupRuntimes: {},
      seats,
      locale: "en-US",
      activePlugins: [],
      createdAt: timestamp,
      updatedAt: timestamp,
    });
    const pending: Proposal[] = [schema()];
    const view = await createWorldModelView(store, sessionId, [], pending);
    expect(view.seats).toEqual(seats);
    expect(Object.isFrozen(view.seats)).toBe(true);
    expect(Object.isFrozen(view.seats[0])).toBe(true);
    pending.push(character());
    expect(view.characters).toHaveLength(1);
    expect(view.seats).toEqual(seats);
    const overlay = overlayWorldModelView(view, sessionId, []);
    expect(overlay.seats).toEqual(seats);
    expect(overlay.seats).not.toBe(view.seats);
    expect(await createWorldModelView(store, "missing", [])).toMatchObject({
      seats: [],
    });
  });
});

describe("a clock-derived dimension in the execution view", () => {
  it("shows a later runtime the value an earlier runtime derived, twice in a row", () => {
    const entry = {
      name: "Countdown",
      schema: {
        type: "integer" as const,
        "x-derive": {
          source: "clock.elapsedSinceStart" as const,
          start: 180,
          perUnit: -1,
        },
      },
      value: 180,
      version: 1,
    };
    const update = (expectedVersion: number, value: number) =>
      proposal("dimension.update", {
        updates: [{ id: "storm", expectedVersion, value }],
      });
    // The second update is applied to a value that is no longer the one a
    // session starts with.
    const view = materializeWorldModel(
      {
        ...base,
        dimensions: { storm: entry },
        dimensionProviderPluginId: "producer",
      },
      [update(1, 170), update(2, 150)],
      sessionId,
    );
    expect(view.dimensions.storm).toMatchObject({ value: 150, version: 3 });
  });
});

describe("world property observations", () => {
  const result = (
    runId: string,
    pendingProposals: Proposal[],
    extra: Partial<RuntimeResult> = {},
  ): RuntimeResult => ({
    pluginId: "producer",
    runtimeId: "producer/run",
    runId,
    turnId: "turn",
    status: "success",
    output: {},
    pendingProposals,
    toolCalls: [],
    durationMs: 0,
    timestamp,
    ...extra,
  });
  it("keeps host copies inert, records only successful property reads and revokes detached views", async () => {
    const store = createMemoryStore();
    const upstream = collectUpstreamWorldWrites(
      new Map([
        ["schema", result("schema-run", [schema()])],
        ["character", result("character-run", [character()])],
        [
          "dimension",
          result("dimension-run", [
            proposal("dimension.update", {
              updates: [{ id: "storm", expectedVersion: 1, value: 2 }],
            }),
          ]),
        ],
      ]),
      sessionId,
    );
    const recorder = new Set<string>();
    const pending: Proposal[] = [];
    const view = await createWorldModelView(
      store,
      sessionId,
      upstream.map((w) => w.proposal),
      pending,
      undefined,
      {
        dimensions: {
          storm: {
            name: "Storm",
            schema: { type: "integer" },
            value: 1,
            version: 1,
          },
        },
        dimensionProviderPluginId: "producer",
      },
      { upstream, recorder },
    );
    const overlay = overlayWorldModelView(view, sessionId);
    const abort = new AbortController();
    const copy = snapshotWorldModelView(overlay, () =>
      abort.signal.throwIfAborted(),
    );
    expect(recorder.size).toBe(0);
    for (const facade of [view, overlay, copy]) {
      expect(facade.dimensions.storm).toMatchObject({ value: 2, version: 2 });
      void facade.worldRecord;
      void facade.seats;
      void facade.dimensionProviderPluginId;
    }
    expect(recorder.size).toBe(0);
    expect(copy.characters[0]?.fields).toEqual({ hp: 5 });
    expect([...recorder]).toEqual(["character-run"]);
    expect(copy.characters).toBe(copy.characters);
    expect(copy.characterSchema).toBe(copy.characterSchema);
    expect([...recorder]).toEqual(["character-run", "schema-run"]);
    (copy.characters[0]!.fields as { hp: number }).hp = 9;
    expect(view.characters[0]?.fields).toEqual({ hp: 5 });
    expect(snapshotWorldModelView(view).characters[0]?.fields).toEqual({
      hp: 5,
    });
    recorder.clear();
    abort.abort();
    expect(() => copy.characters).toThrow();
    expect(recorder.size).toBe(0);
    pending.push(
      proposal("character.upsert", { id: "bad", name: "Bad", type: "unknown" }),
    );
    expect(() => view.characters).toThrow();
    expect(recorder.size).toBe(0);
    pending.pop();
    // Deliberate author serialization observes every enumerable property.
    structuredClone(view);
    expect([...recorder].sort()).toEqual(["character-run", "schema-run"]);
    await store.close();
  });

  it("retains all overwritten producers, with no edges for committed or own-only writes", async () => {
    const store = createMemoryStore();
    const upstream = collectUpstreamWorldWrites(
      new Map([
        ["first", result("first", [schema(), character()])],
        [
          "second",
          result("second", [
            schema(),
            proposal("character.upsert", {
              ...character().payload,
              fields: { hp: 6 },
              expectedVersion: 1,
            }),
          ]),
        ],
      ]),
      sessionId,
    );
    const recorder = new Set<string>();
    const pending = [
      proposal("character.upsert", {
        ...character().payload,
        fields: { hp: 7 },
        expectedVersion: 2,
      }),
      schema(),
    ];
    const view = await createWorldModelView(
      store,
      sessionId,
      upstream.map((w) => w.proposal),
      pending,
      undefined,
      undefined,
      { upstream, recorder },
    );
    expect(view.characters[0]?.fields).toEqual({ hp: 7 });
    expect([...recorder]).toEqual(["first", "second"]);
    void view.characterSchema;
    pending.push(
      proposal("character.upsert", {
        ...character().payload,
        expectedVersion: 3,
      }),
    );
    expect(view.characters[0]?.version).toBe(4);
    expect(view.characters[0]?.version).toBe(4);
    expect([...recorder]).toEqual(["first", "second"]);
    const ownRecorder = new Set<string>();
    const own = await createWorldModelView(
      store,
      sessionId,
      [],
      [schema(), character()],
      undefined,
      undefined,
      { upstream: [], recorder: ownRecorder },
    );
    void own.characters;
    void own.characterSchema;
    await createCommitPipeline(store).commitAll([schema(), character()]);
    const committed = await createWorldModelView(
      store,
      sessionId,
      [],
      [],
      undefined,
      undefined,
      { upstream: [], recorder: ownRecorder },
    );
    void committed.characters;
    void committed.characterSchema;
    expect(ownRecorder.size).toBe(0);
    await store.close();
  });

  it("uses commit eligibility, owned identities, recursive ordering and whole seed exclusion", () => {
    const grandchild = result("grandchild", [schema()]);
    const child = attachNestedResults(result("child", [character()]), [
      grandchild,
    ]);
    const parent = attachNestedResults(result("parent", [character()]), [
      child,
    ]);
    const seed = attachNestedResults(result("seed", [character()]), [
      result("seed-child", [character()]),
    ]);
    const malformed = result("malformed", [character()], {
      effects: { interactions: [null] } as unknown as RuntimeResult["effects"],
    });
    const all = [
      parent,
      seed,
      result("skipped", [character()], { status: "skipped" }),
      result("failed", [character()], { status: "failed" }),
      result("suspended", [character()], { status: "suspended" }),
      result("empty", [character()], { output: undefined }),
      malformed,
    ];
    const writes = collectUpstreamWorldWrites(
      new Map(all.map((r) => [r.runId, r])),
      sessionId,
      new Set([seed]),
    );
    expect(writes.map((w) => w.runId)).toEqual([
      "grandchild",
      "child",
      "parent",
      "skipped",
    ]);
    for (const write of writes)
      expect(write.proposal).toMatchObject({
        sessionId,
        turnId: "turn",
        source: { pluginId: "producer", runtimeId: "producer/run" },
      });
    const original = grandchild.pendingProposals![0]!;
    if (original.type !== "character.schema.set")
      throw new Error("expected schema");
    (original.payload.types as string[]).push("later");
    expect(writes[0]?.proposal.payload).toMatchObject({ types: ["merchant"] });
  });
});
