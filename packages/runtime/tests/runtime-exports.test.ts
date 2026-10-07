/**
 * Unit coverage for the persistent `recordAs` export production / consumption
 * loop (docs 02 §3.4), complementing the end-to-end acceptance scenario 18a:
 *
 *  - publishExecutionExports: revision increment, idempotent-retry on a lost
 *    race, schema-invalid withhold, non-success skip.
 *  - resolveExportBindings: provider-missing / schema-invalid gates, optional
 *    omit, cardinality:all frozen read.
 *  - agent consumption: the reserved `<runtime-exports>` prompt segment mirrors
 *    the function `ctx.exports` slot shape.
 */

import { describe, it, expect } from "vitest";
import { createMemoryStore } from "@covel/store/memory";
import { buildContext } from "@covel/context";
import type {
  RuntimeExportBinding,
  RuntimeExportRecord,
  RuntimeManifest,
} from "@covel/shared";
import { publishExecutionExports } from "../src/commit/runtime-export-publish.js";
import { resolveExportBindings } from "../src/schedule/input-bindings.js";

const SCHEMA = {
  type: "object",
  required: ["threshold"],
  properties: { threshold: { type: "number" } },
} as const;

function successResult(runtimeId: string, value: unknown) {
  return {
    status: "success",
    runtimeId,
    runId: `run-${runtimeId}`,
    output: value,
  };
}

describe("publishExecutionExports", () => {
  const decl = { recordAs: "cfg", pluginId: "p", pluginVersion: "1.0.0" };

  it("rolls back a failed export savepoint while preserving domain writes and later exports", async () => {
    const store = createMemoryStore();
    await store.withTransaction(async (tx) => {
      await tx.upsertStateEntry({
        id: "domain",
        sessionId: "s",
        tableName: "stats",
        fieldName: "hp",
        value: 7,
        updatedAt: "2026-10-07T00:00:00.000Z",
      });
      const failingSink = (sink: typeof tx): typeof tx => ({
        ...sink,
        async appendRuntimeExport(record) {
          const inserted = await sink.appendRuntimeExport(record);
          if (record.producerRuntimeId === "p/broken")
            throw new Error("Export persistence failed");
          return inserted;
        },
        savepoint: (fn) => sink.savepoint!(async (sp) => fn(failingSink(sp))),
      });
      await publishExecutionExports({
        sink: failingSink(tx),
        sessionId: "s",
        results: [
          successResult("p/broken", { threshold: 1 }),
          successResult("p/healthy", { threshold: 2 }),
        ],
        declFor: () => decl,
        loadOutputSchema: async () => SCHEMA,
        committedAt: "2026-10-07T00:00:00.000Z",
      });
    });
    expect((await store.getStateEntry("s", "stats", "hp"))?.value).toBe(7);
    expect(
      await store.getLatestRuntimeExport("s", "p/broken", "cfg"),
    ).toBeNull();
    expect(
      (await store.getLatestRuntimeExport("s", "p/healthy", "cfg"))?.value,
    ).toEqual({ threshold: 2 });
  });

  it("increments revision monotonically per (runtime, recordAs)", async () => {
    const store = createMemoryStore();
    const args = (value: unknown) => ({
      sink: store,
      sessionId: "s",
      results: [successResult("p/gen", value)],
      declFor: (id: string) => (id === "p/gen" ? decl : undefined),
      loadOutputSchema: async () => SCHEMA,
      committedAt: new Date().toISOString(),
    });
    await publishExecutionExports(args({ threshold: 1 }));
    await publishExecutionExports(args({ threshold: 2 }));
    const latest = await store.getLatestRuntimeExport("s", "p/gen", "cfg");
    expect(latest?.revision).toBe(2);
    expect(latest?.value).toEqual({ threshold: 2 });
  });

  it("re-reads and retries once when a revision number was lost to a race", async () => {
    const store = createMemoryStore();
    // Pre-seed revision 1 so the publisher's first append (also revision 1)
    // returns false, forcing the re-read + retry to land revision 2.
    const seed: RuntimeExportRecord = {
      sessionId: "s",
      producerPluginId: "p",
      producerRuntimeId: "p/gen",
      recordAs: "cfg",
      revision: 1,
      pluginVersion: "0.9.0",
      schemaDigest: "seed",
      resultId: "seed",
      value: { threshold: 0 },
      committedAt: "2020-01-01T00:00:00.000Z",
    };
    // Force the lost race: report "no latest" first, so the publisher computes
    // revision 1 and collides with the pre-seeded row.
    let firstLatest = true;
    const racingSink = {
      getLatestRuntimeExport: async (
        sessionId: string,
        producerRuntimeId: string,
        recordAs: string,
      ) => {
        if (firstLatest) {
          firstLatest = false;
          return null; // publisher computes revision 1 → collides
        }
        return store.getLatestRuntimeExport(
          sessionId,
          producerRuntimeId,
          recordAs,
        );
      },
      appendRuntimeExport: (record: RuntimeExportRecord) =>
        store.appendRuntimeExport(record),
    };
    await store.appendRuntimeExport(seed);
    await publishExecutionExports({
      sink: racingSink,
      sessionId: "s",
      results: [successResult("p/gen", { threshold: 5 })],
      declFor: () => decl,
      loadOutputSchema: async () => SCHEMA,
      committedAt: "2020-01-02T00:00:00.000Z",
    });
    const latest = await store.getLatestRuntimeExport("s", "p/gen", "cfg");
    expect(latest?.revision).toBe(2);
    expect(latest?.value).toEqual({ threshold: 5 });
  });

  it("withholds a value that fails output.schema (domain outcome untouched)", async () => {
    const store = createMemoryStore();
    await publishExecutionExports({
      sink: store,
      sessionId: "s",
      results: [successResult("p/gen", { threshold: "nope" })],
      declFor: () => decl,
      loadOutputSchema: async () => SCHEMA,
      committedAt: new Date().toISOString(),
    });
    expect(await store.getLatestRuntimeExport("s", "p/gen", "cfg")).toBeNull();
  });

  it("skips non-success results and runtimes without a recordAs declaration", async () => {
    const store = createMemoryStore();
    await publishExecutionExports({
      sink: store,
      sessionId: "s",
      results: [
        { status: "failed", runtimeId: "p/gen", runId: "r", output: {} },
        successResult("q/other", { threshold: 1 }),
      ],
      declFor: (id) => (id === "p/gen" ? decl : undefined),
      loadOutputSchema: async () => SCHEMA,
      committedAt: new Date().toISOString(),
    });
    expect(await store.getLatestRuntimeExport("s", "p/gen", "cfg")).toBeNull();
    expect(await store.listRuntimeExports("s")).toHaveLength(0);
  });
});

describe("resolveExportBindings", () => {
  const provider = (name: string): RuntimeManifest =>
    ({
      name,
      pluginId: name.split("/")[0],
      outputContract: "cfg-provider",
    }) as RuntimeManifest;
  const binding = (
    over?: Partial<RuntimeExportBinding>,
  ): RuntimeExportBinding => ({
    kind: "runtime-export",
    name: "cfg",
    from: { runtime: "p/gen" },
    recordAs: "cfg",
    ...over,
  });
  const record = (value: unknown): RuntimeExportRecord => ({
    sessionId: "s",
    producerPluginId: "p",
    producerRuntimeId: "p/gen",
    recordAs: "cfg",
    revision: 1,
    pluginVersion: "1.0.0",
    schemaDigest: "d",
    resultId: "r-1",
    value: value as RuntimeExportRecord["value"],
    committedAt: "2020-01-01T00:00:00.000Z",
  });

  it.each(["constructor", "toString", "__proto__"])(
    "resolves prototype-named export %s without an inherited accepts schema",
    async (name) => {
      const result = await resolveExportBindings({
        consumerRuntimeId: "c/main",
        exportBindings: Object.fromEntries([[name, binding({ name })]]),
        activeRuntimes: [provider("p/gen")],
        acceptsSchemas: {},
        getFrozenExport: async () => record({ threshold: 7 }),
      });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(Object.hasOwn(result.slots, name)).toBe(true);
        expect(result.slots[name]?.value).toEqual({ threshold: 7 });
      }
    },
  );

  it("resolves a present export into a provenance-wrapped slot", async () => {
    const res = await resolveExportBindings({
      consumerRuntimeId: "c/main",
      exportBindings: { cfg: binding() },
      activeRuntimes: [provider("p/gen")],
      acceptsSchemas: {},
      getFrozenExport: async () => record({ threshold: 7 }),
    });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.slots.cfg).toEqual({
        cardinality: "one",
        value: { threshold: 7 },
        source: { pluginId: "p", runtimeId: "p/gen", resultId: "r-1" },
      });
    }
  });

  it("skips a required binding when the provider is not in the active set", async () => {
    const res = await resolveExportBindings({
      consumerRuntimeId: "c/main",
      exportBindings: { cfg: binding() },
      activeRuntimes: [],
      acceptsSchemas: {},
      getFrozenExport: async () => record({ threshold: 7 }),
    });
    expect(res).toMatchObject({ ok: false, skipReason: "export-missing" });
  });

  it("skips a required binding when the export value fails accepts", async () => {
    const res = await resolveExportBindings({
      consumerRuntimeId: "c/main",
      exportBindings: { cfg: binding() },
      activeRuntimes: [provider("p/gen")],
      acceptsSchemas: {
        cfg: { type: "object", required: ["ceiling"] },
      },
      getFrozenExport: async () => record({ threshold: 7 }),
    });
    expect(res).toMatchObject({
      ok: false,
      skipReason: "export-schema-invalid",
    });
  });
  it.each([true, false])(
    "validates a public export contract without accepts (required=%s)",
    async (required) => {
      const res = await resolveExportBindings({
        consumerRuntimeId: "c/main",
        exportBindings: {
          cfg: binding({ from: { capability: "cfg-provider" }, required }),
        },
        activeRuntimes: [provider("p/gen")],
        acceptsSchemas: {},
        contractSchemas: { cfg: SCHEMA },
        getFrozenExport: async () => record({ threshold: "invalid" }),
      });
      expect(res.ok).toBe(!required);
      if (res.ok) expect(res.slots).toEqual({});
      expect(res.diagnostics).toContainEqual(
        expect.objectContaining({
          code: "contract-output-invalid",
          severity: "error",
        }),
      );
    },
  );

  it("validates the full public export before an additional consumer accepts check", async () => {
    const res = await resolveExportBindings({
      consumerRuntimeId: "c/main",
      exportBindings: {
        cfg: binding({ from: { capability: "cfg-provider" } }),
      },
      activeRuntimes: [provider("p/gen")],
      acceptsSchemas: {
        cfg: {
          type: "object",
          properties: { threshold: { type: "number", minimum: 10 } },
        },
      },
      contractSchemas: { cfg: SCHEMA },
      getFrozenExport: async () => record({ threshold: 7 }),
    });
    expect(res).toMatchObject({
      ok: false,
      skipReason: "export-schema-invalid",
    });
    expect(res.diagnostics[0]?.code).toBe("export-schema-invalid");
  });

  it("reports an unresolvable public schema reference as an export binding error", async () => {
    const res = await resolveExportBindings({
      consumerRuntimeId: "c/main",
      exportBindings: {
        cfg: binding({ from: { capability: "cfg-provider" } }),
      },
      activeRuntimes: [provider("p/gen")],
      acceptsSchemas: {},
      contractSchemas: { cfg: { $ref: "#/definitions/missing" } },
      getFrozenExport: async () => record({ threshold: 7 }),
    });
    expect(res).toMatchObject({
      ok: false,
      skipReason: "export-schema-invalid",
    });
    expect(res.diagnostics[0]).toMatchObject({
      code: "contract-output-invalid",
      severity: "error",
      message: expect.stringContaining("schema validation failed"),
    });
  });

  it("omits an optional binding whose export is missing (no gate)", async () => {
    const res = await resolveExportBindings({
      consumerRuntimeId: "c/main",
      exportBindings: { cfg: binding({ required: false }) },
      activeRuntimes: [provider("p/gen")],
      acceptsSchemas: {},
      getFrozenExport: async () => null,
    });
    expect(res.ok).toBe(true);
    if (res.ok) expect(Object.keys(res.slots)).toHaveLength(0);
  });

  it("reads one frozen export per provider for cardinality:all, sorted by runtimeId", async () => {
    const res = await resolveExportBindings({
      consumerRuntimeId: "c/main",
      exportBindings: {
        cfg: {
          kind: "runtime-export",
          name: "cfg",
          from: { capability: "cfg-provider", cardinality: "all" },
          recordAs: "cfg",
        },
      },
      activeRuntimes: [provider("p/b"), provider("p/a")],
      acceptsSchemas: {},
      getFrozenExport: async (producerRuntimeId) => ({
        ...record({ from: producerRuntimeId }),
        producerRuntimeId,
      }),
    });
    expect(res.ok).toBe(true);
    if (res.ok && res.slots.cfg.cardinality === "all") {
      expect(res.slots.cfg.items.map((i) => i.source.runtimeId)).toEqual([
        "p/a",
        "p/b",
      ]);
    }
  });

  const resolveAll = (
    accepts: Readonly<Record<string, unknown>>,
    options?: { optional?: boolean; invalidContract?: boolean },
  ) =>
    resolveExportBindings({
      consumerRuntimeId: "c/main",
      exportBindings: {
        cfg: binding({
          from: { capability: "cfg-provider", cardinality: "all" },
          required: !options?.optional,
        }),
      },
      activeRuntimes: [provider("p/b"), provider("p/a")],
      acceptsSchemas: { cfg: accepts },
      contractSchemas: { cfg: SCHEMA },
      getFrozenExport: async (producerRuntimeId) => ({
        ...record({
          threshold:
            options?.invalidContract && producerRuntimeId === "p/b"
              ? "invalid"
              : producerRuntimeId === "p/a"
                ? 1
                : 2,
        }),
        producerRuntimeId,
      }),
    });

  it("validates all committed values as an array before wrapping provenance", async () => {
    const res = await resolveAll({
      type: "array",
      minItems: 2,
      maxItems: 2,
      items: SCHEMA,
    });
    expect(res.ok).toBe(true);
    if (res.ok && res.slots.cfg.cardinality === "all") {
      expect(res.slots.cfg.items.map((item) => item.value)).toEqual([
        { threshold: 1 },
        { threshold: 2 },
      ]);
    }
  });

  it.each([
    { type: "array", minItems: 3, items: SCHEMA },
    { type: "array", maxItems: 1, items: SCHEMA },
    {
      type: "array",
      items: {
        ...SCHEMA,
        properties: { threshold: { type: "number", minimum: 2 } },
      },
    },
  ])("rejects all committed values violating accepts %j", async (schema) => {
    const res = await resolveAll(schema);
    expect(res).toMatchObject({
      ok: false,
      skipReason: "export-schema-invalid",
    });
    expect(res.diagnostics[0]?.code).toBe("export-schema-invalid");
  });

  it("omits an optional all binding that violates the array accepts schema", async () => {
    const res = await resolveAll(
      { type: "array", minItems: 3, items: SCHEMA },
      { optional: true },
    );
    expect(res).toMatchObject({ ok: true, slots: {} });
    expect(res.diagnostics[0]).toMatchObject({
      code: "export-schema-invalid",
      severity: "warn",
    });
  });

  it("rejects invalid individual public exports before array accepts", async () => {
    const res = await resolveAll(
      { type: "array", items: {} },
      { invalidContract: true },
    );
    expect(res).toMatchObject({
      ok: false,
      skipReason: "export-schema-invalid",
    });
    expect(res.diagnostics[0]?.code).toBe("contract-output-invalid");
  });
});

describe("agent export segment", () => {
  it("renders resolved export slots into the reserved <runtime-exports> block", async () => {
    const manifest = {
      name: "c/main",
      pluginId: "c",
      stage: "post-turn",
    } as RuntimeManifest;
    const exportSlots = {
      cfg: {
        cardinality: "one" as const,
        value: { threshold: 7 },
        source: { pluginId: "p", runtimeId: "p/gen", resultId: "r-1" },
      },
    };
    const assembled = await buildContext({
      promptTemplate: "You consume config.",
      manifest,
      turnInput: { sessionId: "s", turnId: "t", playerMessage: "go" },
      completedResults: new Map(),
      exportSlots,
    });
    // An export is read anew each execution: it is data of the turn, behind
    // the conversation.
    expect(assembled.systemPrompt).not.toContain("<runtime-exports>");
    const match = assembled.turnContext.match(
      /<runtime-exports>\n([\s\S]*?)\n<\/runtime-exports>/,
    );
    expect(match).toBeTruthy();
    // The shape a function handler reads from ctx.exports, without the
    // result id: only tools and the kernel use it.
    expect(JSON.parse(match![1]!)).toEqual({
      cfg: {
        ...exportSlots.cfg,
        source: { pluginId: "p", runtimeId: "p/gen" },
      },
    });
  });
});

it("withholds invalid canonical values without growing an existing export revision", async () => {
  const store = createMemoryStore();
  const publish = (value: unknown) =>
    publishExecutionExports({
      sink: store,
      sessionId: "canonical",
      results: [
        {
          status: "success",
          runtimeId: "p/main",
          runId: "run",
          output: { value },
          canonicalValue: { value: value as import("@covel/shared").JsonValue },
        },
      ],
      declFor: () => ({
        recordAs: "number",
        pluginId: "p",
        pluginVersion: "1",
      }),
      loadOutputSchema: async () => ({ type: "number" }),
      committedAt: "2026-01-01T00:00:00Z",
    });
  await publish(7);
  await publish("invalid");
  const latest = await store.getLatestRuntimeExport(
    "canonical",
    "p/main",
    "number",
  );
  expect(latest).toMatchObject({ value: 7, revision: 1 });
});
