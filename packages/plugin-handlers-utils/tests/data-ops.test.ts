// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  DATA_OP_KINDS,
  applyDataOps,
  dataOpSchema,
  dataOpsSchema,
  type DataOp,
  type DataOpErrorCode,
} from "../src/index.js";
import type { JsonValue } from "../src/types.js";

const absent = { exists: false } as const;
const present = (value: JsonValue) => ({ exists: true, value }) as const;

function ok(
  current: Parameters<typeof applyDataOps>[0],
  ...ops: DataOp[]
): JsonValue | undefined {
  const result = applyDataOps(current, ops);
  if (!result.ok) throw new Error(`unexpected ${JSON.stringify(result.error)}`);
  return result.exists ? result.value : undefined;
}

function failure(
  current: Parameters<typeof applyDataOps>[0],
  code: DataOpErrorCode,
  ...ops: DataOp[]
) {
  const result = applyDataOps(current, ops);
  expect(result.ok).toBe(false);
  if (result.ok) return undefined;
  expect(result.error.code).toBe(code);
  expect(result.error.message.length).toBeGreaterThan(0);
  return result.error;
}

describe("applyDataOps: set / delete", () => {
  it("sets a value on an absent and a present key", () => {
    expect(ok(absent, { op: "set", value: { a: 1 } })).toEqual({ a: 1 });
    expect(ok(present(1), { op: "set", value: [2] })).toEqual([2]);
  });

  it("delete ends the key as absent and later ops see it absent", () => {
    expect(applyDataOps(present({ a: 1 }), [{ op: "delete" }])).toEqual({
      ok: true,
      exists: false,
    });
    expect(ok(present(10), { op: "delete" }, { op: "inc", by: 2 })).toBe(2);
  });

  it("returns the input unchanged for an empty list", () => {
    expect(applyDataOps(absent, [])).toEqual({ ok: true, exists: false });
    expect(applyDataOps(present(3), [])).toEqual({
      ok: true,
      exists: true,
      value: 3,
    });
  });
});

describe("applyDataOps: merge", () => {
  it("starts from {} when absent", () => {
    expect(ok(absent, { op: "merge", value: { a: 1 } })).toEqual({ a: 1 });
  });

  it("is shallow and null deletes a key", () => {
    expect(
      ok(present({ a: { x: 1, y: 2 }, b: 1, c: 2 }), {
        op: "merge",
        value: { a: { x: 9 }, b: null },
      }),
    ).toEqual({ a: { x: 9 }, c: 2 });
  });

  it("merges at a path, creating only the final segment", () => {
    expect(
      ok(present({ s: { hp: 1 } }), {
        op: "merge",
        path: "/s",
        value: { mp: 2 },
      }),
    ).toEqual({ s: { hp: 1, mp: 2 } });
    expect(
      ok(present({ s: {} }), { op: "merge", path: "/t", value: { a: 1 } }),
    ).toEqual({ s: {}, t: { a: 1 } });
  });

  it("rejects non-object targets", () => {
    failure(present([1]), "type-mismatch", { op: "merge", value: { a: 1 } });
    failure(present(1), "type-mismatch", { op: "merge", value: { a: 1 } });
    failure(present(null), "type-mismatch", { op: "merge", value: { a: 1 } });
  });
});

describe("applyDataOps: inc", () => {
  it("starts from 0 when absent, with and without a path", () => {
    expect(ok(absent, { op: "inc", by: 5 })).toBe(5);
    expect(ok(absent, { op: "inc", path: "/hp", by: 5 })).toEqual({ hp: 5 });
    expect(ok(present({ hp: 1 }), { op: "inc", path: "/hp", by: -3 })).toEqual({
      hp: -2,
    });
  });

  it("rejects out-of-range results by default", () => {
    failure(present(9), "out-of-bounds", { op: "inc", by: 5, max: 10 });
    failure(present(1), "out-of-bounds", { op: "inc", by: -5, min: 0 });
    failure(present(9), "out-of-bounds", {
      op: "inc",
      by: 5,
      max: 10,
      onBound: "reject",
    });
  });

  it("clamps with onBound clamp, with min only or max only", () => {
    expect(
      ok(present(9), { op: "inc", by: 5, max: 10, onBound: "clamp" }),
    ).toBe(10);
    expect(
      ok(present(1), { op: "inc", by: -5, min: 0, onBound: "clamp" }),
    ).toBe(0);
    expect(
      ok(present(1), { op: "inc", by: 1, min: 0, max: 3, onBound: "clamp" }),
    ).toBe(2);
  });

  it("checks bounds on the result only", () => {
    expect(
      ok(present(100), { op: "inc", by: -1, max: 10, onBound: "clamp" }),
    ).toBe(10);
    expect(ok(present(100), { op: "inc", by: 0, min: 0 })).toBe(100);
  });

  it("rejects non-number targets and non-finite results", () => {
    failure(present("1"), "type-mismatch", { op: "inc", by: 1 });
    failure(present([]), "type-mismatch", { op: "inc", by: 1 });
    failure(present(Number.MAX_VALUE), "out-of-bounds", {
      op: "inc",
      by: Number.MAX_VALUE,
    });
  });

  it("never yields negative zero", () => {
    expect(Object.is(ok(present(-1), { op: "inc", by: 1 }), 0)).toBe(true);
  });
});

describe("applyDataOps: append / insert", () => {
  it("append starts from [] and appends at a path", () => {
    expect(ok(absent, { op: "append", value: 1 })).toEqual([1]);
    expect(ok(present([1]), { op: "append", value: [2] })).toEqual([1, [2]]);
    expect(
      ok(present({ log: ["a"] }), { op: "append", path: "/log", value: "b" }),
    ).toEqual({ log: ["a", "b"] });
    expect(ok(absent, { op: "append", path: "/log", value: "b" })).toEqual({
      log: ["b"],
    });
  });

  it("insert at 0, in the middle and at length; length+1 is rejected", () => {
    expect(ok(present([1, 2]), { op: "insert", index: 0, value: 0 })).toEqual([
      0, 1, 2,
    ]);
    expect(ok(present([1, 3]), { op: "insert", index: 1, value: 2 })).toEqual([
      1, 2, 3,
    ]);
    expect(ok(present([1, 2]), { op: "insert", index: 2, value: 3 })).toEqual([
      1, 2, 3,
    ]);
    failure(present([1, 2]), "index-out-of-range", {
      op: "insert",
      index: 3,
      value: 3,
    });
    expect(ok(absent, { op: "insert", index: 0, value: "x" })).toEqual(["x"]);
    failure(absent, "index-out-of-range", {
      op: "insert",
      index: 1,
      value: "x",
    });
  });

  it("rejects non-array targets", () => {
    failure(present({}), "type-mismatch", { op: "append", value: 1 });
    failure(present("a"), "type-mismatch", {
      op: "insert",
      index: 0,
      value: 1,
    });
  });
});

describe("applyDataOps: remove", () => {
  it("removes every deep-equal value, order of keys irrelevant", () => {
    expect(
      ok(present([1, { a: 1, b: 2 }, 2, { b: 2, a: 1 }, 1]), {
        op: "remove",
        value: { a: 1, b: 2 },
      }),
    ).toEqual([1, 2, 1]);
    expect(ok(present([1, 2, 1]), { op: "remove", value: 1 })).toEqual([2]);
  });

  it("removes by subset match and skips non-objects", () => {
    expect(
      ok(present([{ id: 1, n: "a" }, { id: 2 }, 3, { id: 1, n: "b" }]), {
        op: "remove",
        match: { id: 1 },
      }),
    ).toEqual([{ id: 2 }, 3]);
  });

  it("zero matches is a successful no-op", () => {
    expect(ok(present([1, 2]), { op: "remove", value: 9 })).toEqual([1, 2]);
    expect(ok(present([{ a: 1 }]), { op: "remove", match: { a: 2 } })).toEqual([
      { a: 1 },
    ]);
  });

  it("rejects a non-array target and a malformed selector", () => {
    failure(present({}), "type-mismatch", { op: "remove", value: 1 });
    failure(present([1]), "invalid-op", { op: "remove" } as DataOp);
    failure(present([1]), "invalid-op", {
      op: "remove",
      value: 1,
      match: { a: 1 },
    });
    failure(present([{}]), "invalid-op", { op: "remove", match: {} });
  });
});

describe("applyDataOps: upsertItem", () => {
  it("appends when no element matches, including on an absent key", () => {
    expect(
      ok(absent, { op: "upsertItem", key: "id", value: { id: "a", n: 1 } }),
    ).toEqual([{ id: "a", n: 1 }]);
    expect(
      ok(present([{ id: "a" }]), {
        op: "upsertItem",
        key: "id",
        value: { id: "b" },
      }),
    ).toEqual([{ id: "a" }, { id: "b" }]);
  });

  it("shallow-merges into the one match and skips non-objects", () => {
    expect(
      ok(present([1, { id: "a", n: 1, deep: { x: 1 } }]), {
        op: "upsertItem",
        key: "id",
        value: { id: "a", n: 2, deep: { y: 2 } },
      }),
    ).toEqual([1, { id: "a", n: 2, deep: { y: 2 } }]);
  });

  it("rejects more than one match", () => {
    failure(present([{ id: 1 }, { id: 1 }]), "duplicate-item", {
      op: "upsertItem",
      key: "id",
      value: { id: 1 },
    });
  });

  it("requires value[key] to be a primitive", () => {
    failure(present([]), "invalid-op", {
      op: "upsertItem",
      key: "id",
      value: { name: "x" },
    });
    failure(present([]), "invalid-op", {
      op: "upsertItem",
      key: "id",
      value: { id: { a: 1 } },
    });
  });

  it("rejects a non-array target", () => {
    failure(present({}), "type-mismatch", {
      op: "upsertItem",
      key: "id",
      value: { id: 1 },
    });
  });
});

describe("applyDataOps: paths", () => {
  it("resolves escaped tokens and array indexes", () => {
    expect(
      ok(present({ "a/b": { "c~d": 1 }, list: [0, 1] }), {
        op: "inc",
        path: "/a~1b/c~0d",
        by: 1,
      }),
    ).toEqual({ "a/b": { "c~d": 2 }, list: [0, 1] });
    expect(
      ok(present({ list: [0, 1] }), { op: "inc", path: "/list/1", by: 5 }),
    ).toEqual({ list: [0, 6] });
    expect(ok(present({ "": 1 }), { op: "inc", path: "/", by: 1 })).toEqual({
      "": 2,
    });
  });

  it("rejects malformed pointers with invalid-path", () => {
    for (const path of ["a", "/a~2", "/a~", "/list/01", "/list/-", "/list/x"]) {
      const error = failure(present({ a: 1, list: [1, 2] }), "invalid-path", {
        op: "inc",
        path,
        by: 1,
      });
      expect(error?.path).toBe(path);
    }
  });

  it("reports a missing intermediate and never creates containers", () => {
    const error = failure(present({}), "path-not-found", {
      op: "inc",
      path: "/a/b",
      by: 1,
    });
    expect(error?.opIndex).toBe(0);
    failure(absent, "path-not-found", { op: "inc", path: "/a/b", by: 1 });
    failure(present({ list: [1] }), "path-not-found", {
      op: "inc",
      path: "/list/3",
      by: 1,
    });
    failure(present({ a: 1 }), "type-mismatch", {
      op: "inc",
      path: "/a/b",
      by: 1,
    });
  });

  it("treats an empty path as the whole value", () => {
    expect(ok(present(1), { op: "inc", path: "", by: 1 })).toBe(2);
  });

  it("rejects reserved segments and keys, leaving Object.prototype alone", () => {
    for (const token of ["__proto__", "constructor", "prototype"]) {
      failure(present({}), "invalid-path", {
        op: "merge",
        path: `/${token}`,
        value: { polluted: true },
      });
      failure(present({}), "invalid-op", {
        op: "merge",
        value: JSON.parse(`{"${token}":{"polluted":true}}`),
      });
      failure(present([]), "invalid-op", {
        op: "upsertItem",
        key: "id",
        value: JSON.parse(`{"id":1,"${token}":{"polluted":true}}`),
      });
      failure(present([]), "invalid-op", {
        op: "remove",
        match: JSON.parse(`{"${token}":1}`),
      });
    }
    expect(({} as { polluted?: unknown }).polluted).toBeUndefined();
    expect(
      Object.prototype.hasOwnProperty.call(Object.prototype, "polluted"),
    ).toBe(false);
  });

  it("keeps results plain and JSON round-trippable", () => {
    const result = ok(present({ a: { b: 1 } }), {
      op: "merge",
      path: "/a",
      value: { c: 2 },
    });
    expect(Object.getPrototypeOf(result)).toBe(Object.prototype);
    expect(JSON.parse(JSON.stringify(result))).toEqual(result);
  });
});

describe("applyDataOps: present/absent and root/path matrix", () => {
  const cases: {
    name: string;
    current: Parameters<typeof applyDataOps>[0];
    op: DataOp;
    expected: JsonValue | undefined;
  }[] = [
    {
      name: "insert at a path, present",
      current: present({ log: ["a", "c"] }),
      op: { op: "insert", path: "/log", index: 1, value: "b" },
      expected: { log: ["a", "b", "c"] },
    },
    {
      name: "insert at a path, absent root starts from {}",
      current: absent,
      op: { op: "insert", path: "/log", index: 0, value: "x" },
      expected: { log: ["x"] },
    },
    {
      name: "insert at a path, absent final key",
      current: present({ other: 1 }),
      op: { op: "insert", path: "/log", index: 0, value: "x" },
      expected: { other: 1, log: ["x"] },
    },
    {
      name: "remove by value at a path, present",
      current: present({ tags: ["a", "b", "a"], n: 1 }),
      op: { op: "remove", path: "/tags", value: "a" },
      expected: { tags: ["b"], n: 1 },
    },
    {
      name: "remove by match at a path, present",
      current: present({ items: [{ id: 1 }, { id: 2 }] }),
      op: { op: "remove", path: "/items", match: { id: 1 } },
      expected: { items: [{ id: 2 }] },
    },
    {
      name: "remove on an absent root yields an empty array",
      current: absent,
      op: { op: "remove", value: 1 },
      expected: [],
    },
    {
      name: "remove at a path on an absent root yields an empty array there",
      current: absent,
      op: { op: "remove", path: "/tags", value: "a" },
      expected: { tags: [] },
    },
    {
      name: "remove at an absent final key yields an empty array there",
      current: present({ n: 1 }),
      op: { op: "remove", path: "/tags", match: { id: 1 } },
      expected: { n: 1, tags: [] },
    },
    {
      name: "merge on an absent root with a path",
      current: absent,
      op: { op: "merge", path: "/stats", value: { hp: 3 } },
      expected: { stats: { hp: 3 } },
    },
    {
      name: "merge at a path, present",
      current: present({ stats: { hp: 1 }, n: 1 }),
      op: { op: "merge", path: "/stats", value: { mp: 2, hp: null } },
      expected: { stats: { mp: 2 }, n: 1 },
    },
    {
      name: "upsertItem at a path, appends when no element matches",
      current: present({ list: [{ id: "a" }] }),
      op: { op: "upsertItem", path: "/list", key: "id", value: { id: "b" } },
      expected: { list: [{ id: "a" }, { id: "b" }] },
    },
    {
      name: "upsertItem at a path, merges into the match",
      current: present({ list: [{ id: "a", n: 1 }] }),
      op: {
        op: "upsertItem",
        path: "/list",
        key: "id",
        value: { id: "a", n: 2 },
      },
      expected: { list: [{ id: "a", n: 2 }] },
    },
    {
      name: "upsertItem at a path on an absent root",
      current: absent,
      op: { op: "upsertItem", path: "/list", key: "id", value: { id: "a" } },
      expected: { list: [{ id: "a" }] },
    },
    {
      name: "delete of an absent key stays absent",
      current: absent,
      op: { op: "delete" },
      expected: undefined,
    },
    {
      name: "delete of a present key",
      current: present({ a: 1 }),
      op: { op: "delete" },
      expected: undefined,
    },
  ];

  it.each(cases)("$name", ({ current, op, expected }) => {
    const result = applyDataOps(current, [op]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    if (expected === undefined)
      expect(result).toEqual({ ok: true, exists: false });
    else expect(result).toEqual({ ok: true, exists: true, value: expected });
  });
});

describe("applyDataOps: atomicity and purity", () => {
  it("returns the first error with its index and no value", () => {
    const result = applyDataOps(present(1), [
      { op: "inc", by: 1 },
      { op: "append", value: 1 },
      { op: "inc", by: 1 },
    ]);
    expect(result.ok).toBe(false);
    expect(result).not.toHaveProperty("value");
    if (!result.ok) expect(result.error.opIndex).toBe(1);
  });

  it("does not mutate the current value or op values", () => {
    const current = { list: [{ id: 1, a: { x: 1 } }], n: 1 };
    const opValue = { id: 1, a: { y: 2 } };
    const snapshot = structuredClone({ current, opValue });
    const result = applyDataOps(present(current), [
      { op: "inc", path: "/n", by: 1 },
      { op: "upsertItem", path: "/list", key: "id", value: opValue },
      { op: "append", path: "/list", value: opValue },
      { op: "merge", value: { n: null } },
    ]);
    expect(result).toEqual({
      ok: true,
      exists: true,
      value: {
        list: [
          { id: 1, a: { y: 2 } },
          { id: 1, a: { y: 2 } },
        ],
      },
    });
    expect({ current, opValue }).toEqual(snapshot);
  });

  it("never throws on malformed direct calls", () => {
    const bad = [
      null,
      42,
      {},
      { op: "nope" },
      { op: "inc", by: Number.NaN },
      { op: "inc", by: 1, min: 5, max: 1 },
      { op: "inc", by: 1, onBound: "wrap" },
      { op: "insert", index: -1, value: 1 },
      { op: "insert", index: 1.5, value: 1 },
      { op: "append", value: undefined },
      { op: "set", value: () => 1 },
      { op: "merge", value: [] },
      { op: "inc", path: 5, by: 1 },
    ] as unknown as DataOp[];
    for (const op of bad) {
      const result = applyDataOps(present([1]), [op]);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe("invalid-op");
    }
    // A hostile getter must not escape from error reporting either.
    const hostile = {
      op: "inc",
      by: 1,
      get path(): string {
        throw new Error("bad");
      },
    } as unknown as DataOp;
    const hostileResult = applyDataOps(present(1), [hostile]);
    expect(hostileResult.ok).toBe(false);
    if (!hostileResult.ok) {
      expect(hostileResult.error.code).toBe("invalid-op");
      expect(hostileResult.error.opIndex).toBe(0);
      expect(hostileResult.error).not.toHaveProperty("path");
    }
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(
      applyDataOps(present([]), [{ op: "append", value: cyclic as JsonValue }])
        .ok,
    ).toBe(false);
  });
});

describe("dataOpSchema / dataOpsSchema", () => {
  it("accepts every op kind", () => {
    const valid: DataOp[] = [
      { op: "set", value: { a: [1, "x", null, true] } },
      { op: "merge", path: "/a", value: { x: 1, y: null } },
      { op: "inc", by: 1, min: 0, max: 5, onBound: "clamp" },
      { op: "append", value: "x" },
      { op: "insert", index: 0, value: 1 },
      { op: "remove", value: 1 },
      { op: "remove", match: { id: 1 } },
      { op: "upsertItem", key: "id", value: { id: "a" } },
      { op: "delete" },
    ];
    for (const op of valid)
      expect(dataOpSchema.safeParse(op).success, op.op).toBe(true);
    expect(new Set(valid.map((op) => op.op))).toEqual(new Set(DATA_OP_KINDS));
  });

  it("rejects NaN, Infinity and undefined values", () => {
    for (const bad of [
      { op: "set", value: Number.NaN },
      { op: "set", value: Number.POSITIVE_INFINITY },
      { op: "set", value: undefined },
      { op: "set", value: { a: undefined } },
      { op: "append", value: [Number.NaN] },
      { op: "inc", by: Number.NaN },
      { op: "inc", by: Number.POSITIVE_INFINITY },
      { op: "inc", by: 1, min: Number.NEGATIVE_INFINITY },
      { op: "insert", index: 0, value: undefined },
    ])
      expect(dataOpSchema.safeParse(bad).success, JSON.stringify(bad)).toBe(
        false,
      );
  });

  it("rejects unknown keys, missing fields and bad shapes", () => {
    for (const bad of [
      { op: "set", value: 1, path: "/a" },
      { op: "delete", path: "/a" },
      { op: "inc", by: 1, extra: true },
      { op: "set" },
      { op: "other" },
      { op: "insert", value: 1 },
      { op: "insert", index: -1, value: 1 },
      { op: "insert", index: 1.5, value: 1 },
      { op: "inc", by: 1, min: 5, max: 1 },
      { op: "inc", by: 1, onBound: "wrap" },
      { op: "remove" },
      { op: "remove", value: 1, match: { a: 1 } },
      { op: "remove", match: {} },
      { op: "upsertItem", key: "id", value: { name: "x" } },
      { op: "upsertItem", key: "id", value: { id: [1] } },
      { op: "merge", value: [] },
      { op: "append", path: "a", value: 1 },
      { op: "append", path: "/a~2", value: 1 },
      { op: "append", path: "/__proto__/x", value: 1 },
    ])
      expect(dataOpSchema.safeParse(bad).success, JSON.stringify(bad)).toBe(
        false,
      );
  });

  it("rejects reserved keys in merge, upsertItem and match", () => {
    for (const token of ["__proto__", "constructor", "prototype"]) {
      expect(
        dataOpSchema.safeParse({
          op: "merge",
          value: JSON.parse(`{"${token}":1}`),
        }).success,
      ).toBe(false);
      expect(
        dataOpSchema.safeParse({
          op: "upsertItem",
          key: "id",
          value: JSON.parse(`{"id":1,"${token}":1}`),
        }).success,
      ).toBe(false);
      expect(
        dataOpSchema.safeParse({
          op: "remove",
          match: JSON.parse(`{"${token}":1}`),
        }).success,
      ).toBe(false);
    }
  });

  it("bounds the list to 1..64 operations", () => {
    const op = { op: "delete" } as const;
    expect(dataOpsSchema.safeParse([]).success).toBe(false);
    expect(dataOpsSchema.safeParse([op]).success).toBe(true);
    expect(
      dataOpsSchema.safeParse(Array.from({ length: 64 }, () => op)).success,
    ).toBe(true);
    expect(
      dataOpsSchema.safeParse(Array.from({ length: 65 }, () => op)).success,
    ).toBe(false);
  });
});
