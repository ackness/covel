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
import { createMemoryStore } from "@covel/store";
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
      capabilities: ["cfg-provider"],
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
});

describe("agent export segment", () => {
  it("renders resolved export slots into the reserved <runtime-exports> block", () => {
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
    const assembled = buildContext({
      promptTemplate: "You consume config.",
      manifest,
      turnInput: { sessionId: "s", turnId: "t", playerMessage: "go" },
      completedResults: new Map(),
      exportSlots,
    });
    const match = assembled.systemPrompt.match(
      /<runtime-exports>\n([\s\S]*?)\n<\/runtime-exports>/,
    );
    expect(match).toBeTruthy();
    // Same JSON shape a function handler reads from ctx.exports.
    expect(JSON.parse(match![1]!)).toEqual(exportSlots);
  });
});
