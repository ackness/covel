import { describe, expect, it } from "vitest";
import { createMemoryStore } from "@covel/store";
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
  collectUpstreamWorldProposals,
} from "../src/function-runtime/world-model-view.js";
import { createCommitPipeline } from "../src/session/session-kernel.js";
import { executeTurn } from "../src/turn-executor/turn-executor.js";

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
    (first[0]!.fields as { hp: number }).hp = 100;
    expect(view.characters[0]!.fields).toEqual({ hp: 5 });
    const firstSchema = view.characterSchema!;
    (firstSchema.types as string[]).push("mutated");
    expect(view.characterSchema!.types).toEqual(["merchant"]);
    await store.upsertCharacterSchema({
      ...firstSchema,
      version: 100,
      types: ["other"],
    });
    expect(view.characterSchema!.version).toBe(1);
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
      "second player",
      () => [
        proposal("character.upsert", {
          id: "one",
          name: "One",
          type: "player",
        }),
        proposal("character.upsert", {
          id: "two",
          name: "Two",
          type: "player",
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
      expect(
        stored.filter((record) => record.type === "player").length,
      ).toBeLessThanOrEqual(1);
      expect(stored.every((record) => record.type !== "undeclared")).toBe(true);
      expect(
        stored.every(
          (record) =>
            !record.fields || (record.fields as { hp?: number }).hp !== 11,
        ),
      ).toBe(true);
    },
  );

  it("ignores failed/suspended results and rebinds completed proposal identity like commit", () => {
    const result = (status: RuntimeResult["status"]): RuntimeResult => ({
      pluginId: "actual",
      runtimeId: "actual/run",
      turnId: "actual-turn",
      status,
      output: withPendingProposals({}, [{ ...schema(), sessionId: "forged" }]),
    });
    const collected = collectUpstreamWorldProposals(
      new Map([
        ["failed", result("failed")],
        ["success", result("success")],
        ["skipped", result("skipped")],
      ]),
      sessionId,
    );
    expect(collected).toHaveLength(2);
    expect(collected[0]).toMatchObject({
      sessionId,
      turnId: "actual-turn",
      source: { pluginId: "actual", runtimeId: "actual/run" },
    });
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
            input: {
              inject: [
                {
                  kind: "runtime" as const,
                  from: `provider/${index === 1 ? "schema" : "character"}`,
                  field: "ready",
                  as: "upstream",
                },
              ],
            },
          }
        : {}),
    }));
    const seen: unknown[] = [];
    const result = await executeTurn(
      { sessionId, turnId: "turn", playerMessage: "go" },
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
