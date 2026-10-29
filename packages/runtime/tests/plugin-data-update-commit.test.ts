/**
 * `plugin.data.update` at commit: the kernel reads the stored row inside the
 * commit transaction, applies the operations with `applyDataOps` and writes
 * the result back, after the reserved-namespace, size and dataset checks. The
 * in-execution overlay projects the same operations with the same function,
 * which the property test at the end pins down.
 */

import { afterEach, describe, expect, it } from "vitest";
import {
  MAX_PLUGIN_DATA_VALUE_BYTES,
  applyDataOps,
  type DataOp,
  type DataOpsCurrent,
  type JsonValue,
  type ProposalFor,
  type ProposalType,
  type ProposalPayloadMap,
} from "@covel/shared";
import type { DataStore } from "@covel/store";
import { overlayPluginDataValue } from "@covel/tools";
import { createMemoryStore } from "@covel/store/memory";
import { createSqliteStore } from "@covel/store/sqlite";
import { createCommitPipeline } from "../src/commit/session-commit-pipeline.js";
import {
  datasetPolicyResolver,
  type DatasetSchemas,
} from "../src/commit/commit-plugin-data.js";
import { createHookPipeline } from "../src/hooks/pipeline.js";

const SESSION = "s";
const PLUGIN = "probe";
const at = "2026-10-29T00:00:00.000Z";

const open: DataStore[] = [];
afterEach(async () => {
  await Promise.all(open.splice(0).map((store) => store.close()));
});

async function setup(
  create: () => DataStore = createMemoryStore,
): Promise<DataStore> {
  const store = create();
  open.push(store);
  await store.createSession({
    id: SESSION,
    status: "active",
    phase: "playing",
    completedPlayerTurns: 0,
    setupRuntimes: {},
    activePlugins: [PLUGIN],
    metadata: {},
    locale: "en-US",
    createdAt: at,
    updatedAt: at,
  });
  return store;
}

function proposal<K extends ProposalType>(
  type: K,
  payload: ProposalPayloadMap[K],
  pluginId = PLUGIN,
): ProposalFor<K> {
  return {
    id: crypto.randomUUID(),
    type,
    source: { pluginId, runtimeId: `${pluginId}/main` },
    sessionId: SESSION,
    turnId: "turn",
    payload,
    timestamp: at,
  } as ProposalFor<K>;
}

const update = (ops: readonly DataOp[], namespace = "wallet", key = "gold") =>
  proposal("plugin.data.update", { namespace, key, ops });
const set = (value: unknown, namespace = "wallet", key = "gold") =>
  proposal("plugin.data", { namespace, key, value });
const remove = (namespace = "wallet", key = "gold") =>
  proposal("plugin.data.delete", { namespace, key });

async function seed(
  store: DataStore,
  value: unknown,
  namespace = "wallet",
  key = "gold",
): Promise<void> {
  await store.setPluginData({
    id: crypto.randomUUID(),
    sessionId: SESSION,
    pluginId: PLUGIN,
    namespace,
    key,
    value,
    createdAt: at,
    updatedAt: at,
  });
}

async function stored(
  store: DataStore,
  namespace = "wallet",
  key = "gold",
): Promise<DataOpsCurrent> {
  const row = await store.getPluginData(SESSION, PLUGIN, namespace, key);
  return row
    ? { exists: true, value: row.value as JsonValue }
    : { exists: false };
}

const OP_CASES: readonly (readonly [string, JsonValue, readonly DataOp[]])[] = [
  ["set", { a: 1 }, [{ op: "set", value: { b: [1, 2] } }]],
  ["merge", { a: 1, b: 2 }, [{ op: "merge", value: { a: 3, b: null } }]],
  ["inc", 10, [{ op: "inc", by: -4, min: 0 }]],
  ["inc at a path", { n: 1 }, [{ op: "inc", path: "/n", by: 2.5 }]],
  ["append", [1], [{ op: "append", value: { x: null } }]],
  ["insert", ["b"], [{ op: "insert", index: 0, value: "a" }]],
  ["remove by value", [1, 2, 1], [{ op: "remove", value: 1 }]],
  [
    "remove by match",
    [{ id: "a" }, { id: "b" }],
    [{ op: "remove", match: { id: "a" } }],
  ],
  [
    "upsertItem",
    [{ id: "a", qty: 1 }],
    [
      { op: "upsertItem", key: "id", value: { id: "a", qty: 2 } },
      { op: "upsertItem", key: "id", value: { id: "b", qty: 1 } },
    ],
  ],
];

describe("plugin.data.update commit", () => {
  it.each(OP_CASES)(
    "%s commits what applyDataOps computes, on an absent and an existing key",
    async (_label, base, ops) => {
      for (const current of [
        { exists: false } as const,
        { exists: true, value: base } as const,
      ]) {
        const store = await setup();
        if (current.exists) await seed(store, current.value);
        const expected = applyDataOps(current, ops);
        const [result] = await createCommitPipeline(store).commitAll([
          update(ops),
        ]);
        if (!expected.ok) {
          expect(result).toMatchObject({
            committed: false,
            code: "data-op-rejected",
          });
          expect(await stored(store)).toEqual(current);
          continue;
        }
        expect(result).toMatchObject({ committed: true });
        expect(await stored(store)).toEqual(
          expected.exists
            ? { exists: true, value: expected.value }
            : { exists: false },
        );
      }
    },
  );

  it("rejects an out-of-bounds inc with data-op-rejected and leaves the row", async () => {
    const store = await setup();
    await seed(store, 2);
    const result = await createCommitPipeline(store).commit(
      update([{ op: "inc", by: -3, min: 0 }]),
    );
    expect(result).toEqual({
      committed: false,
      code: "data-op-rejected",
      error:
        "plugin.data.update: inc result is outside the allowed range (op 0, out-of-bounds)",
    });
    expect(await stored(store)).toEqual({ exists: true, value: 2 });
  });

  it("names the failing op's path in the rejection", async () => {
    const store = await setup();
    await seed(store, { n: "text" });
    const result = await createCommitPipeline(store).commit(
      update([
        { op: "merge", value: { m: 1 } },
        { op: "inc", path: "/n", by: 1 },
      ]),
    );
    expect(result.error).toBe(
      "plugin.data.update: inc needs a number target (op 1 at /n, type-mismatch)",
    );
  });

  it("deletes the row when the ops end absent, and is a committed no-op without one", async () => {
    const store = await setup();
    await seed(store, 5);
    const pipeline = createCommitPipeline(store);
    expect(await pipeline.commit(update([{ op: "delete" }]))).toEqual({
      committed: true,
    });
    expect(await stored(store)).toEqual({ exists: false });
    expect(await pipeline.commit(update([{ op: "delete" }]))).toEqual({
      committed: true,
    });
    expect(await stored(store)).toEqual({ exists: false });
  });

  it("keeps the row's id and createdAt on a rewrite", async () => {
    const store = await setup();
    await seed(store, 1);
    const before = await store.getPluginData(SESSION, PLUGIN, "wallet", "gold");
    await createCommitPipeline(store).commit(update([{ op: "inc", by: 1 }]));
    const after = await store.getPluginData(SESSION, PLUGIN, "wallet", "gold");
    expect(after).toMatchObject({
      id: before!.id,
      createdAt: before!.createdAt,
      value: 2,
    });
  });

  it("rejects a reserved namespace and accepts the plugin's own _hidden.*", async () => {
    const store = await setup();
    const pipeline = createCommitPipeline(store);
    const reserved = await pipeline.commit(
      update([{ op: "set", value: 1 }], "_logs", "k"),
    );
    expect(reserved).toMatchObject({ committed: false });
    expect(reserved.error).toMatch(/^plugin\.data\.update: /);
    expect(await stored(store, "_logs", "k")).toEqual({ exists: false });
    expect(
      await pipeline.commit(
        update([{ op: "inc", by: 1 }], "_hidden.state", "k"),
      ),
    ).toEqual({ committed: true });
    expect(await stored(store, "_hidden.state", "k")).toEqual({
      exists: true,
      value: 1,
    });
  });

  it("rejects an oversized result even when the ops are small", async () => {
    const store = await setup();
    const chunk = "x".repeat(4096);
    const near = Array.from(
      { length: Math.floor(MAX_PLUGIN_DATA_VALUE_BYTES / 4100) - 1 },
      () => chunk,
    );
    await seed(store, near);
    const pipeline = createCommitPipeline(store);
    let result = await pipeline.commit(
      update([{ op: "append", value: chunk }]),
    );
    let appended = 0;
    while (result.committed && appended < 8) {
      appended += 1;
      result = await pipeline.commit(update([{ op: "append", value: chunk }]));
    }
    expect(result).toMatchObject({ committed: false });
    expect(result.error).toMatch(/^plugin\.data\.update: .*byte limit/);
    const row = await stored(store);
    expect(row.exists && (row.value as unknown[]).length).toBe(
      near.length + appended,
    );
  });

  it("re-validates ops a PreStateCommit hook rewrote", async () => {
    const store = await setup();
    await seed(store, 1);
    const hooks = createHookPipeline();
    hooks.register<{ proposal: ProposalFor<"plugin.data.update"> }>({
      id: "rewrite",
      event: "PreStateCommit",
      async handler(_ctx, payload) {
        return {
          action: "continue",
          replace: {
            proposal: {
              ...payload.proposal,
              payload: { ...payload.proposal.payload, ops: [] },
            },
          },
        };
      },
    });
    const result = await createCommitPipeline(store, hooks).commit(
      update([{ op: "inc", by: 1 }]),
    );
    expect(result).toMatchObject({ committed: false });
    expect(result.error).toMatch(/^plugin\.data\.update: invalid payload/);
    expect(await stored(store)).toEqual({ exists: true, value: 1 });
  });

  it("applies two updates of one key in order inside one commitAll", async () => {
    const store = await setup();
    await seed(store, { gold: 1, log: [] });
    const results = await createCommitPipeline(store).commitAll([
      update([
        { op: "inc", path: "/gold", by: 4 },
        { op: "append", path: "/log", value: "first" },
      ]),
      // Passes only against the first update's result (5 - 5 >= 0).
      update([
        { op: "inc", path: "/gold", by: -5, min: 0 },
        { op: "append", path: "/log", value: "second" },
      ]),
    ]);
    expect(results.map((r) => r.committed)).toEqual([true, true]);
    expect(await stored(store)).toEqual({
      exists: true,
      value: { gold: 0, log: ["first", "second"] },
    });
  });
});

for (const [backend, create] of [
  ["memory", createMemoryStore],
  ["sqlite", () => createSqliteStore(":memory:")],
] as const) {
  describe(`plugin.data.update commit path: ${backend}`, () => {
    it("commits inc and upsertItem", async () => {
      const store = await setup(create);
      await seed(store, { gold: 3, items: [{ id: "a", qty: 1 }] });
      const results = await createCommitPipeline(store).commitAll([
        update([
          { op: "inc", path: "/gold", by: 2 },
          {
            op: "upsertItem",
            path: "/items",
            key: "id",
            value: { id: "a", qty: 2 },
          },
          {
            op: "upsertItem",
            path: "/items",
            key: "id",
            value: { id: "b", qty: -1.5, note: null },
          },
        ]),
      ]);
      expect(results).toEqual([{ committed: true }]);
      expect(await stored(store)).toEqual({
        exists: true,
        value: {
          gold: 5,
          items: [
            { id: "a", qty: 2 },
            { id: "b", qty: -1.5, note: null },
          ],
        },
      });
    });

    it("sums two sequential commitAll calls with inc on one key", async () => {
      const store = await setup(create);
      await seed(store, 10);
      const pipeline = createCommitPipeline(store);
      await pipeline.commitAll([update([{ op: "inc", by: 1 }])]);
      await pipeline.commitAll([update([{ op: "inc", by: 1 }])]);
      expect(await stored(store)).toEqual({ exists: true, value: 12 });
    });

    it("leaves the row of a rejected op list while its siblings commit", async () => {
      const store = await setup(create);
      await seed(store, 1);
      const results = await createCommitPipeline(store).commitAll([
        set("sibling", "notes", "a"),
        update([{ op: "inc", by: -5, min: 0 }]),
        update([{ op: "append", value: 1 }], "list", "k"),
      ]);
      expect(results.map((r) => r.committed)).toEqual([true, false, true]);
      expect(results[1]).toMatchObject({ code: "data-op-rejected" });
      expect(await stored(store)).toEqual({ exists: true, value: 1 });
      expect(await stored(store, "notes", "a")).toEqual({
        exists: true,
        value: "sibling",
      });
      expect(await stored(store, "list", "k")).toEqual({
        exists: true,
        value: [1],
      });
    });
  });
}

describe("dataset rules at commit", () => {
  const inventorySchema = {
    type: "array",
    items: {
      type: "object",
      properties: {
        id: { type: "string" },
        qty: { type: "integer", minimum: 0 },
      },
      required: ["id", "qty"],
    },
  };
  const notesSchema = {
    type: "object",
    properties: { text: { type: "string" } },
    required: ["text"],
  };
  const runtimes = [
    {
      pluginId: PLUGIN,
      datasets: {
        inventory: {
          namespace: "inventory",
          ops: ["upsertItem", "remove"] as const,
        },
        notes: {
          namespace: "notes",
          ops: ["set", "merge", "delete"] as const,
        },
      },
    },
  ];
  const schemas: DatasetSchemas = {
    [PLUGIN]: { inventory: inventorySchema, notes: notesSchema },
  };
  const pipelineFor = (store: DataStore, captured: DatasetSchemas = schemas) =>
    createCommitPipeline(store, undefined, undefined, undefined, undefined, {
      datasetPolicy: datasetPolicyResolver(runtimes, captured),
    });

  it("refuses an op kind outside ops", async () => {
    const store = await setup();
    const result = await pipelineFor(store).commit(
      update([{ op: "append", value: { id: "a", qty: 1 } }], "inventory", "k"),
    );
    expect(result).toEqual({
      committed: false,
      code: "dataset-violation",
      error:
        "plugin.data.update: dataset inventory: operation kind append is not allowed",
    });
    expect(await stored(store, "inventory", "k")).toEqual({ exists: false });
  });

  it("refuses a result that violates the record schema", async () => {
    const store = await setup();
    await seed(store, [{ id: "a", qty: 1 }], "inventory", "k");
    const result = await pipelineFor(store).commit(
      update(
        [{ op: "upsertItem", key: "id", value: { id: "a", qty: -1 } }],
        "inventory",
        "k",
      ),
    );
    expect(result).toMatchObject({
      committed: false,
      code: "dataset-violation",
    });
    expect(result.error).toMatch(
      /^plugin\.data\.update: dataset inventory: record does not match its schema \(\/0\/qty must be >= 0\)$/,
    );
    expect(await stored(store, "inventory", "k")).toEqual({
      exists: true,
      value: [{ id: "a", qty: 1 }],
    });
  });

  it("commits an allowed op whose result matches", async () => {
    const store = await setup();
    expect(
      await pipelineFor(store).commit(
        update(
          [{ op: "upsertItem", key: "id", value: { id: "a", qty: 2 } }],
          "inventory",
          "k",
        ),
      ),
    ).toEqual({ committed: true });
  });

  it("counts a plain write as set and a delete as delete", async () => {
    const store = await setup();
    await seed(store, [], "inventory", "k");
    const pipeline = pipelineFor(store);
    expect(
      await pipeline.commit(set([{ id: "a", qty: 1 }], "inventory", "k")),
    ).toMatchObject({
      code: "dataset-violation",
      error:
        "plugin.data: dataset inventory: operation kind set is not allowed",
    });
    expect(await pipeline.commit(remove("inventory", "k"))).toMatchObject({
      code: "dataset-violation",
      error:
        "plugin.data.delete: dataset inventory: operation kind delete is not allowed",
    });
    expect(await stored(store, "inventory", "k")).toEqual({
      exists: true,
      value: [],
    });
    expect(await pipeline.commit(set({ text: "ok" }, "notes", "n"))).toEqual({
      committed: true,
    });
    expect(await pipeline.commit(remove("notes", "n"))).toEqual({
      committed: true,
    });
  });

  it("validates plain writes against the schema", async () => {
    const store = await setup();
    const result = await pipelineFor(store).commit(
      set({ text: 3 }, "notes", "n"),
    );
    expect(result).toMatchObject({ code: "dataset-violation" });
    expect(result.error).toMatch(/record does not match its schema/);
  });

  it("refuses the whole batch when one item violates the schema", async () => {
    const store = await setup();
    const result = await pipelineFor(store).commit(
      proposal("plugin.data.batch", {
        items: [
          { namespace: "free", key: "a", value: 1 },
          { namespace: "notes", key: "n", value: { body: "no text" } },
        ],
      }),
    );
    expect(result).toMatchObject({
      committed: false,
      code: "dataset-violation",
    });
    expect(result.error).toMatch(/^plugin\.data\.batch: dataset notes: /);
    expect(await stored(store, "free", "a")).toEqual({ exists: false });
  });

  it("reports at most three schema errors", async () => {
    const store = await setup();
    const many = await pipelineFor(store, {
      [PLUGIN]: {
        inventory: inventorySchema,
        notes: {
          type: "object",
          properties: {
            a: { type: "string" },
            b: { type: "string" },
            c: { type: "string" },
            d: { type: "string" },
          },
        },
      },
    }).commit(set({ a: 1, b: 1, c: 1, d: 1 }, "notes", "n"));
    expect(many.code).toBe("dataset-violation");
    const listed = /\((.*)\)$/.exec(many.error ?? "")?.[1]?.split("; ");
    expect(listed).toHaveLength(3);
  });

  it("leaves an undeclared namespace unchecked", async () => {
    const store = await setup();
    expect(
      await pipelineFor(store).commit(
        update([{ op: "append", value: "anything" }], "free", "k"),
      ),
    ).toEqual({ committed: true });
    expect(
      await pipelineFor(store).commit(
        update([{ op: "append", value: 1 }], "inventory", "k"),
      ),
    ).toMatchObject({ code: "dataset-violation" });
  });

  it("checks only the declaring plugin's namespace", async () => {
    const store = await setup();
    expect(
      await pipelineFor(store).commit(
        proposal(
          "plugin.data",
          { namespace: "inventory", key: "k", value: "free form" },
          "other",
        ),
      ),
    ).toEqual({ committed: true });
  });

  it("fails closed when a declared dataset has no captured schema", async () => {
    const store = await setup();
    const pipeline = pipelineFor(store, {});
    for (const write of [
      set({ text: "ok" }, "notes", "n"),
      update([{ op: "merge", value: { text: "ok" } }], "notes", "n"),
      remove("notes", "n"),
    ])
      expect(await pipeline.commit(write)).toEqual({
        committed: false,
        code: "dataset-violation",
        error: `${write.type}: dataset schema of notes is unavailable`,
      });
  });
});

// ── Overlay ≡ commit ──────────────────────────────────────────────────

const CASES = 300;

/** mulberry32: a small seeded PRNG so a failure can be replayed. */
function makeRng(seed: number) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    int: (n: number) => Math.floor(next() * n),
    pick: <T>(items: readonly T[]): T =>
      items[Math.floor(next() * items.length)] as T,
    chance: (p: number) => next() < p,
  };
}
type Rng = ReturnType<typeof makeRng>;

function genPrimitive(rng: Rng): JsonValue {
  switch (rng.int(4)) {
    case 0:
      return rng.int(9) - 4;
    case 1:
      return rng.pick(["a", "b", ""]);
    case 2:
      return rng.chance(0.5);
    default:
      return null;
  }
}

function genJson(rng: Rng, depth: number): JsonValue {
  if (depth <= 0 || rng.chance(0.35)) return genPrimitive(rng);
  if (rng.chance(0.5))
    return Array.from({ length: rng.int(3) }, () =>
      rng.chance(0.5)
        ? { id: rng.pick(["a", "b"]), n: rng.int(5) }
        : genJson(rng, depth - 1),
    );
  const out: Record<string, JsonValue> = {};
  for (let i = rng.int(3); i > 0; i--)
    out[rng.pick(["n", "items", "a"])] = genJson(rng, depth - 1);
  return out;
}

function genOp(rng: Rng): DataOp {
  const path = rng.pick(["", "", "/n", "/items", "/a", "/0"]);
  const at = path === "" ? {} : { path };
  switch (rng.int(8)) {
    case 0:
      return { op: "set", value: genJson(rng, 2) };
    case 1:
      return { op: "merge", ...at, value: { n: genPrimitive(rng), a: null } };
    case 2:
      return {
        op: "inc",
        ...at,
        by: rng.int(7) - 3,
        ...(rng.chance(0.4) ? { min: 0 } : {}),
        ...(rng.chance(0.2) ? { max: 3, onBound: "clamp" as const } : {}),
      };
    case 3:
      return { op: "append", ...at, value: genPrimitive(rng) };
    case 4:
      return { op: "insert", ...at, index: rng.int(3), value: rng.int(3) };
    case 5:
      return rng.chance(0.5)
        ? { op: "remove", ...at, value: genPrimitive(rng) }
        : { op: "remove", ...at, match: { id: rng.pick(["a", "b"]) } };
    case 6:
      return {
        op: "upsertItem",
        ...at,
        key: "id",
        value: { id: rng.pick(["a", "b"]), n: rng.int(5) },
      };
    default:
      return { op: "delete" };
  }
}

function genProposal(rng: Rng) {
  const roll = rng.int(10);
  if (roll === 0) return remove();
  if (roll <= 2) return set(genJson(rng, 3));
  return update(Array.from({ length: 1 + rng.int(3) }, () => genOp(rng)));
}

describe("overlay and commit agree", () => {
  it(`projects what commitAll stores (${CASES} seeded cases)`, async () => {
    const baseSeed = 0x5eed1202;
    let appliedUpdates = 0;
    let skippedUpdates = 0;
    for (let i = 0; i < CASES; i++) {
      const caseSeed = baseSeed + i;
      const rng = makeRng(caseSeed);
      const base: DataOpsCurrent = rng.chance(0.25)
        ? { exists: false }
        : { exists: true, value: genJson(rng, 3) };
      const list = Array.from({ length: 1 + rng.int(5) }, () =>
        genProposal(rng),
      );

      // Which proposals the overlay skips: an update failing on its state.
      let state = base;
      const skipped: boolean[] = [];
      for (const entry of list) {
        if (entry.type !== "plugin.data.update") {
          skipped.push(false);
          state =
            entry.type === "plugin.data"
              ? { exists: true, value: entry.payload.value as JsonValue }
              : { exists: false };
          continue;
        }
        const step = applyDataOps(state, entry.payload.ops);
        skipped.push(!step.ok);
        if (step.ok) appliedUpdates += 1;
        else skippedUpdates += 1;
        if (step.ok)
          state = step.exists
            ? { exists: true, value: step.value }
            : { exists: false };
      }

      const projected = overlayPluginDataValue(
        list,
        PLUGIN,
        "wallet",
        "gold",
        base,
      );
      const store = createMemoryStore();
      try {
        if (base.exists) await seed(store, base.value);
        const results = await createCommitPipeline(store).commitAll(list);
        const context = `seed ${caseSeed}: ${JSON.stringify({ base, list: list.map((p) => p.payload) })}`;
        expect(
          results.map((result) => !result.committed),
          `commit fails exactly when the overlay skips (${context})`,
        ).toEqual(skipped);
        const { hit: _hit, ...value } = projected;
        expect(await stored(store), context).toEqual(value);
      } finally {
        await store.close();
      }
    }
    // The generator must exercise both outcomes.
    expect(appliedUpdates).toBeGreaterThan(CASES / 2);
    expect(skippedUpdates).toBeGreaterThan(CASES / 10);
  });
});
