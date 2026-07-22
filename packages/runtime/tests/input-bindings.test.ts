/**
 * Input-binding resolver matrix (docs 02 §3, 01 §4). Unit-level coverage of
 * `resolveInputBindings` / `deriveActivation` / `hasIllegalDetachedContract` /
 * `checkAcceptsCompatibility`, plus the DAG ordering edges bindings imply.
 */

import { describe, it, expect } from "vitest";
import type {
  RuntimeActivation,
  RuntimeManifest,
  RuntimeResult,
  TurnInput,
} from "@covel/shared";
import {
  deriveActivation,
  hasIllegalDetachedContract,
  resolveInputBindings,
} from "../src/schedule/input-bindings.js";
import {
  checkAcceptsCompatibility,
  projectSchemaBySelect,
  resolveJsonPointer,
} from "../src/schedule/accepts-compat.js";
import { scheduleByDag } from "../src/schedule/dag-scheduler.js";

type Schema = Readonly<Record<string, unknown>>;

function rt(
  name: string,
  opts: {
    capabilities?: readonly string[];
    inputs?: RuntimeManifest["inputs"];
    execution?: "sync" | "background";
    trigger?: RuntimeManifest["trigger"];
    priority?: number;
  } = {},
): RuntimeManifest {
  return {
    name,
    pluginId: name.split("/")[0],
    description: name,
    priority: opts.priority ?? 500,
    runtimeType: "function",
    handler: "./h.js",
    trigger: opts.trigger ?? { type: "auto" },
    outputKind: "plugin",
    capabilities: opts.capabilities ?? [],
    ...(opts.inputs ? { inputs: opts.inputs } : {}),
    ...(opts.execution ? { execution: opts.execution } : {}),
  } as RuntimeManifest;
}

function success(runtimeId: string, output: unknown): RuntimeResult {
  return {
    pluginId: runtimeId.split("/")[0]!,
    runtimeId,
    runId: `run-${runtimeId}`,
    turnId: "t",
    status: "success",
    output: output as RuntimeResult["output"],
    toolCalls: [],
    durationMs: 1,
    timestamp: new Date().toISOString(),
  };
}

const STAGE: RuntimeActivation = {
  source: "stage",
  detached: false,
  payload: null,
};

const baseArgs = (over: {
  manifest: RuntimeManifest;
  activation?: RuntimeActivation;
  activeRuntimes?: readonly RuntimeManifest[];
  completedResults?: ReadonlyMap<string, RuntimeResult>;
  acceptsSchemas?: Readonly<Record<string, Schema>>;
  loadProducerSchema?: (m: RuntimeManifest) => Promise<Schema | undefined>;
}) => ({
  manifest: over.manifest,
  activation: over.activation ?? STAGE,
  activeRuntimes: over.activeRuntimes ?? [],
  completedResults: over.completedResults ?? new Map<string, RuntimeResult>(),
  acceptsSchemas: over.acceptsSchemas ?? {},
  loadProducerSchema: over.loadProducerSchema ?? (async () => undefined),
});

describe("deriveActivation", () => {
  const input = (extra: Partial<TurnInput> = {}): TurnInput => ({
    sessionId: "s",
    turnId: "t",
    playerMessage: "go",
    ...extra,
  });

  it("stage when no manual/event signal", () => {
    expect(deriveActivation(rt("p/x"), input(), undefined)).toEqual({
      source: "stage",
      detached: false,
      payload: null,
    });
  });

  it("manual reads manualTrigger.payload; null when absent", () => {
    const m = rt("p/x");
    expect(
      deriveActivation(
        m,
        input({ manualTrigger: { runtimeId: "p/x", payload: { a: 1 } } }),
        undefined,
      ),
    ).toEqual({ source: "manual", detached: false, payload: { a: 1 } });
    expect(
      deriveActivation(
        m,
        input({ manualTrigger: { runtimeId: "p/x" } }),
        undefined,
      ).payload,
    ).toBeNull();
  });

  it("event reads triggerEvent.data and wins over a manual target", () => {
    const m = rt("p/x");
    expect(
      deriveActivation(m, input({ manualTrigger: { runtimeId: "p/x" } }), {
        topic: "e",
        data: { b: 2 },
      }),
    ).toEqual({ source: "event", detached: false, payload: { b: 2 } });
  });

  it("event/manual detach according to execution:background", () => {
    const bg = rt("p/x", { execution: "background" });
    expect(
      deriveActivation(bg, input(), { topic: "e", data: {} }).detached,
    ).toBe(true);
    expect(deriveActivation(bg, input(), undefined).detached).toBe(false); // stage stays attached
  });
});

describe("resolveJsonPointer / projectSchemaBySelect", () => {
  it("resolves a pointer and distinguishes absent from null", () => {
    expect(resolveJsonPointer({ a: { b: 3 } }, "/a/b")).toEqual({
      found: true,
      value: 3,
    });
    expect(resolveJsonPointer({ a: null }, "/a")).toEqual({
      found: true,
      value: null,
    });
    expect(resolveJsonPointer({ a: 1 }, "/nope").found).toBe(false);
    expect(resolveJsonPointer({ a: 1 }, "").value).toEqual({ a: 1 });
  });

  it("projects a schema through properties", () => {
    const schema = { type: "object", properties: { n: { type: "number" } } };
    expect(projectSchemaBySelect(schema, "/n")).toEqual({ type: "number" });
    expect(projectSchemaBySelect(schema, "/missing")).toBeUndefined();
  });
});

describe("checkAcceptsCompatibility (decidable subset)", () => {
  it("proves a looser accepts object compatible", () => {
    expect(
      checkAcceptsCompatibility(
        {
          type: "object",
          properties: { text: { type: "string" } },
          required: ["text"],
        },
        { type: "object", properties: { text: { type: "string" } } },
      ),
    ).toBe("compatible");
  });

  it("proves a type mismatch incompatible", () => {
    expect(
      checkAcceptsCompatibility({ type: "number" }, { type: "string" }),
    ).toBe("incompatible");
  });

  it("returns indeterminate for combinator keywords", () => {
    expect(
      checkAcceptsCompatibility(
        { type: "string" },
        { oneOf: [{ type: "string" }] },
      ),
    ).toBe("indeterminate");
  });

  it("compares numeric bounds and anchored mime prefixes", () => {
    expect(
      checkAcceptsCompatibility(
        { type: "number", minimum: 2 },
        { type: "number", minimum: 0 },
      ),
    ).toBe("compatible");
    expect(
      checkAcceptsCompatibility(
        { type: "number", minimum: -1 },
        { type: "number", minimum: 0 },
      ),
    ).toBe("incompatible");
    expect(
      checkAcceptsCompatibility(
        { const: "audio/mpeg" },
        { type: "string", pattern: "^audio/" },
      ),
    ).toBe("compatible");
    expect(
      checkAcceptsCompatibility(
        { const: "image/png" },
        { type: "string", pattern: "^audio/" },
      ),
    ).toBe("incompatible");
  });
});

describe("resolveInputBindings — cardinality & providers", () => {
  const consumerOne = rt("c/main", {
    inputs: { data: { from: { capability: "prov" }, required: true } },
  });

  it("0 providers → missing-provider (required)", async () => {
    const res = await resolveInputBindings(baseArgs({ manifest: consumerOne }));
    expect(res).toMatchObject({ ok: false, skipReason: "missing-provider" });
  });

  it("0 providers → omit slot (optional)", async () => {
    const optional = rt("c/main", {
      inputs: { data: { from: { capability: "prov" }, required: false } },
    });
    const res = await resolveInputBindings(baseArgs({ manifest: optional }));
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.slots.data).toBeUndefined();
  });

  it("1 provider → resolved slot with provenance", async () => {
    const provider = rt("p/gen", { capabilities: ["prov"] });
    const res = await resolveInputBindings(
      baseArgs({
        manifest: rt("c/main", {
          inputs: {
            data: { from: { capability: "prov" }, select: "/payload" },
          },
        }),
        activeRuntimes: [provider],
        completedResults: new Map([
          ["p/gen", success("p/gen", { payload: { x: 42 } })],
        ]),
      }),
    );
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.slots.data).toEqual({
        cardinality: "one",
        value: { x: 42 },
        source: { pluginId: "p", runtimeId: "p/gen", resultId: "run-p/gen" },
      });
    }
  });

  it("N providers + cardinality:one → cardinality-conflict", async () => {
    const res = await resolveInputBindings(
      baseArgs({
        manifest: consumerOne,
        activeRuntimes: [
          rt("p/a", { capabilities: ["prov"] }),
          rt("p/b", { capabilities: ["prov"] }),
        ],
        completedResults: new Map([
          ["p/a", success("p/a", {})],
          ["p/b", success("p/b", {})],
        ]),
      }),
    );
    expect(res).toMatchObject({
      ok: false,
      skipReason: "cardinality-conflict",
    });
  });

  it("cardinality:all → provider-runtimeId-sorted item array", async () => {
    const res = await resolveInputBindings(
      baseArgs({
        manifest: rt("c/main", {
          inputs: {
            data: {
              from: { capability: "prov", cardinality: "all" },
              select: "/v",
            },
          },
        }),
        activeRuntimes: [
          rt("p/b", { capabilities: ["prov"] }),
          rt("p/a", { capabilities: ["prov"] }),
        ],
        completedResults: new Map([
          ["p/a", success("p/a", { v: "A" })],
          ["p/b", success("p/b", { v: "B" })],
        ]),
      }),
    );
    expect(res.ok).toBe(true);
    if (res.ok && res.slots.data.cardinality === "all") {
      expect(res.slots.data.items.map((i) => i.value)).toEqual(["A", "B"]);
      expect(res.slots.data.items.map((i) => i.source.runtimeId)).toEqual([
        "p/a",
        "p/b",
      ]);
    }
  });

  it("cardinality:all requires every provider to succeed", async () => {
    const res = await resolveInputBindings(
      baseArgs({
        manifest: rt("c/main", {
          inputs: {
            data: {
              from: { capability: "prov", cardinality: "all" },
              required: true,
            },
          },
        }),
        activeRuntimes: [
          rt("p/a", { capabilities: ["prov"] }),
          rt("p/b", { capabilities: ["prov"] }),
        ],
        completedResults: new Map([["p/a", success("p/a", {})]]), // p/b never ran
      }),
    );
    expect(res).toMatchObject({ ok: false, skipReason: "upstream-failed" });
  });
});

describe("resolveInputBindings — select & required/optional", () => {
  const provider = rt("p/gen", {});
  const runtimeBinding = (required: boolean, select: string) =>
    rt("c/main", {
      inputs: { data: { from: { runtime: "p/gen" }, select, required } },
    });

  it("missing pointer → input-missing (required) / omit (optional)", async () => {
    const completed = new Map([["p/gen", success("p/gen", { other: 1 })]]);
    const req = await resolveInputBindings(
      baseArgs({
        manifest: runtimeBinding(true, "/data"),
        activeRuntimes: [provider],
        completedResults: completed,
      }),
    );
    expect(req).toMatchObject({ ok: false, skipReason: "input-missing" });
    const opt = await resolveInputBindings(
      baseArgs({
        manifest: runtimeBinding(false, "/data"),
        activeRuntimes: [provider],
        completedResults: completed,
      }),
    );
    expect(opt.ok).toBe(true);
    if (opt.ok) expect(opt.slots.data).toBeUndefined();
  });

  it("non-success upstream → upstream-failed (required)", async () => {
    const res = await resolveInputBindings(
      baseArgs({
        manifest: runtimeBinding(true, ""),
        activeRuntimes: [provider],
      }),
    );
    expect(res).toMatchObject({ ok: false, skipReason: "upstream-failed" });
  });
});

describe("resolveInputBindings — accepts double layer", () => {
  const provider = rt("p/gen", { capabilities: ["prov"] });
  const args = (
    accepts: Schema,
    producerSchema: Schema,
    value: unknown,
    select?: string,
  ) =>
    baseArgs({
      manifest: rt("c/main", {
        inputs: {
          data: {
            from: { capability: "prov" },
            ...(select ? { select } : {}),
            accepts: "./a.json",
          },
        },
      }),
      activeRuntimes: [provider],
      completedResults: new Map([["p/gen", success("p/gen", value)]]),
      acceptsSchemas: { data: accepts },
      loadProducerSchema: async () => producerSchema,
    });

  it("statically incompatible producer → input-schema-incompatible + error diagnostic", async () => {
    const res = await resolveInputBindings(
      args(
        { type: "string" },
        { type: "object", properties: { n: { type: "number" } } },
        { n: 5 },
        "/n",
      ),
    );
    expect(res).toMatchObject({
      ok: false,
      skipReason: "input-schema-incompatible",
    });
    expect(
      res.diagnostics.some((d) => d.code === "input-schema-incompatible"),
    ).toBe(true);
  });

  it("indeterminate schema → diagnostic, then runtime check decides", async () => {
    // oneOf → indeterminate; the actual value passes the full runtime schema.
    const pass = await resolveInputBindings(
      args(
        { oneOf: [{ type: "string" }, { type: "number" }] },
        { type: "object" },
        "hello",
        "",
      ),
    );
    expect(pass.ok).toBe(true);
    expect(
      pass.diagnostics.some(
        (d) => d.code === "slot-compatibility-indeterminate",
      ),
    ).toBe(true);

    // Same indeterminate static result, but the value fails runtime → skip.
    const fail = await resolveInputBindings(
      args(
        { oneOf: [{ type: "string" }] },
        { type: "object" },
        { not: "a string" },
        "",
      ),
    );
    expect(fail).toMatchObject({
      ok: false,
      skipReason: "input-schema-invalid",
    });
  });

  it("cardinality:all validates each item statically and the whole array at runtime", async () => {
    const accepts = { type: "array", items: { type: "string" } };
    const res = await resolveInputBindings(
      baseArgs({
        manifest: rt("c/main", {
          inputs: {
            data: {
              from: { capability: "prov", cardinality: "all" },
              accepts: "./a.json",
            },
          },
        }),
        activeRuntimes: [
          rt("p/a", { capabilities: ["prov"] }),
          rt("p/b", { capabilities: ["prov"] }),
        ],
        completedResults: new Map([
          ["p/a", success("p/a", "A")],
          ["p/b", success("p/b", "B")],
        ]),
        acceptsSchemas: { data: accepts },
        loadProducerSchema: async () => ({ type: "string" }),
      }),
    );
    expect(res.ok).toBe(true);

    // Producer declares string (statically compatible) but actually emits a
    // number — the whole-array runtime check catches it.
    const bad = await resolveInputBindings(
      baseArgs({
        manifest: rt("c/main", {
          inputs: {
            data: {
              from: { capability: "prov", cardinality: "all" },
              accepts: "./a.json",
            },
          },
        }),
        activeRuntimes: [rt("p/a", { capabilities: ["prov"] })],
        completedResults: new Map([["p/a", success("p/a", 7)]]),
        acceptsSchemas: { data: accepts },
        loadProducerSchema: async () => ({ type: "string" }),
      }),
    );
    expect(bad).toMatchObject({
      ok: false,
      skipReason: "input-schema-invalid",
    });
  });
});

describe("bindings imply DAG ordering edges", () => {
  it("a capability binding places the consumer after its provider", () => {
    const provider = rt("p/gen", { capabilities: ["prov"], priority: 600 });
    const consumer = rt("c/main", {
      inputs: { data: { from: { capability: "prov" } } },
      priority: 500, // lower priority, but the binding edge must still order it last
    });
    const { groups, error } = scheduleByDag([consumer, provider]);
    expect(error).toBeUndefined();
    const levelOf = (name: string) =>
      groups.findIndex((g) => g.runtimes.some((r) => r.name === name));
    expect(levelOf("p/gen")).toBeLessThan(levelOf("c/main"));
  });
});

describe("hasIllegalDetachedContract", () => {
  it("rejects an always-detached spec that declares turn bindings", () => {
    const bad = rt("p/x", {
      trigger: { type: "event", topic: "e" },
      execution: "background",
      inputs: { data: { from: { runtime: "p/gen" } } },
    });
    expect(hasIllegalDetachedContract(bad)).toBe(true);
  });

  it("accepts an always-detached spec without bindings, and a non-detached one with bindings", () => {
    expect(
      hasIllegalDetachedContract(
        rt("p/x", {
          trigger: { type: "event", topic: "e" },
          execution: "background",
        }),
      ),
    ).toBe(false);
    expect(
      hasIllegalDetachedContract(
        rt("p/x", { inputs: { data: { from: { runtime: "p/gen" } } } }),
      ),
    ).toBe(false);
  });
});
