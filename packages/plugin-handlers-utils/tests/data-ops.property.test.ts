// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  applyDataOps,
  type DataOp,
  type DataOpsCurrent,
} from "../src/index.js";
import type { JsonValue } from "../src/types.js";

const CASES = 600;

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
    next,
    int: (n: number) => Math.floor(next() * n),
    pick: <T>(items: readonly T[]): T =>
      items[Math.floor(next() * items.length)] as T,
    chance: (p: number) => next() < p,
  };
}
type Rng = ReturnType<typeof makeRng>;

const KEYS = ["a", "b", "id", "n", "a/b", "c~d"] as const;

function genPrimitive(rng: Rng): JsonValue {
  switch (rng.int(5)) {
    case 0:
      return rng.int(7) - 3;
    case 1:
      return rng.pick(["x", "y", ""]);
    case 2:
      return rng.chance(0.5);
    case 3:
      return null;
    default:
      return rng.int(100) / 4;
  }
}

function genJson(rng: Rng, depth: number): JsonValue {
  if (depth <= 0 || rng.chance(0.4)) return genPrimitive(rng);
  if (rng.chance(0.5))
    return Array.from({ length: rng.int(4) }, () => genJson(rng, depth - 1));
  const out: Record<string, JsonValue> = {};
  for (let i = rng.int(4); i > 0; i--)
    out[rng.pick(KEYS)] = genJson(rng, depth - 1);
  return out;
}

function escapeToken(token: string): string {
  return token.replace(/~/g, "~0").replace(/\//g, "~1");
}

/** Every pointer that exists in `value`, plus one absent final segment. */
function pointers(value: JsonValue | undefined, prefix = ""): string[] {
  const out = [prefix];
  if (Array.isArray(value))
    value.forEach((item, i) => out.push(...pointers(item, `${prefix}/${i}`)));
  else if (typeof value === "object" && value !== null) {
    for (const [key, item] of Object.entries(value))
      out.push(...pointers(item, `${prefix}/${escapeToken(key)}`));
    out.push(`${prefix}/${escapeToken("fresh")}`);
  }
  return out;
}

function genState(rng: Rng): DataOpsCurrent {
  return rng.chance(0.1)
    ? { exists: false }
    : { exists: true, value: genJson(rng, 3) };
}

function genObject(rng: Rng): Record<string, JsonValue> {
  const out: Record<string, JsonValue> = {};
  for (let i = 1 + rng.int(3); i > 0; i--)
    out[rng.pick(KEYS)] = genJson(rng, 1);
  return out;
}

/** An op aimed at the current state so a fair share of them succeed. */
function genOp(rng: Rng, state: DataOpsCurrent): DataOp {
  const value = state.exists ? state.value : undefined;
  const path = rng.chance(0.7) ? rng.pick(pointers(value)) : "";
  const p = path === "" && rng.chance(0.5) ? {} : { path };
  switch (rng.int(8)) {
    case 0:
      return { op: "set", value: genJson(rng, 2) };
    case 1:
      return {
        op: "merge",
        ...p,
        value: { ...genObject(rng), [rng.pick(KEYS)]: null },
      };
    case 2: {
      const lo = rng.int(10) - 5;
      return {
        op: "inc",
        ...p,
        by: rng.int(9) - 4,
        ...(rng.chance(0.6) ? { min: lo } : {}),
        ...(rng.chance(0.6) ? { max: lo + rng.int(10) } : {}),
        ...(rng.chance(0.5)
          ? { onBound: rng.pick(["reject", "clamp"] as const) }
          : {}),
      };
    }
    case 3:
      return { op: "append", ...p, value: genJson(rng, 2) };
    case 4:
      return { op: "insert", ...p, index: rng.int(4), value: genJson(rng, 2) };
    case 5:
      return rng.chance(0.5)
        ? { op: "remove", ...p, value: genPrimitive(rng) }
        : {
            op: "remove",
            ...p,
            match: { [rng.pick(KEYS)]: genPrimitive(rng) },
          };
    case 6: {
      const key = rng.pick(KEYS);
      return {
        op: "upsertItem",
        ...p,
        key,
        value: { ...genObject(rng), [key]: rng.int(3) },
      };
    }
    default:
      return { op: "delete" };
  }
}

interface Shape {
  n: number;
  tags: JsonValue[];
  obj: Record<string, JsonValue>;
  items: { id: number; v: number }[];
}

/** A state of known shape, so valid ops can be built without the code under test. */
function genShape(rng: Rng): Shape {
  const ids = [0, 1, 2, 3].filter(() => rng.chance(0.5));
  return {
    n: rng.int(40) - 20,
    tags: Array.from({ length: rng.int(4) }, () => genPrimitive(rng)),
    obj: genObject(rng),
    items: ids.map((id) => ({ id, v: rng.int(5) })),
  };
}

/**
 * A run of ops that is valid by construction on a `Shape` state, with the
 * expected end state computed by an independent reference model. It never
 * consults `applyDataOps`, so the properties cannot pass vacuously.
 */
function genValidRun(rng: Rng, start: Shape, length: number) {
  const model = structuredClone(start);
  const ops: DataOp[] = [];
  for (let i = 0; i < length; i++) {
    switch (rng.int(6)) {
      case 0: {
        const by = rng.int(21) - 10;
        ops.push({ op: "inc", path: "/n", by });
        model.n += by;
        break;
      }
      case 1: {
        const value = genJson(rng, 2);
        ops.push({ op: "append", path: "/tags", value });
        model.tags.push(value);
        break;
      }
      case 2: {
        const value = genJson(rng, 1);
        const index = rng.int(model.tags.length + 1);
        ops.push({ op: "insert", path: "/tags", index, value });
        model.tags.splice(index, 0, value);
        break;
      }
      case 3: {
        const value = genPrimitive(rng);
        ops.push({ op: "remove", path: "/tags", value });
        model.tags = model.tags.filter((tag) => !Object.is(tag, value));
        break;
      }
      case 4: {
        const key = rng.pick(["x", "y", "z"]);
        const entry = rng.chance(0.3) ? null : genJson(rng, 1);
        ops.push({ op: "merge", path: "/obj", value: { [key]: entry } });
        if (entry === null) delete model.obj[key];
        else model.obj[key] = entry;
        break;
      }
      default: {
        const id = rng.int(4);
        const v = rng.int(5);
        ops.push({
          op: "upsertItem",
          path: "/items",
          key: "id",
          value: { id, v },
        });
        const hit = model.items.find((item) => item.id === id);
        if (hit) hit.v = v;
        else model.items.push({ id, v });
      }
    }
  }
  return { ops, end: model };
}

function seeded(name: string, property: (rng: Rng, seed: number) => void) {
  it(name, () => {
    for (let c = 0; c < CASES; c++) {
      const seed = 1000 + c;
      try {
        property(makeRng(seed), seed);
      } catch (error) {
        throw new Error(`${name}: failed with seed ${seed}: ${String(error)}`, {
          cause: error,
        });
      }
    }
  });
}

describe("applyDataOps properties", () => {
  seeded("is pure: inputs are unchanged", (rng) => {
    const state = genState(rng);
    const ops = Array.from({ length: 1 + rng.int(5) }, () => genOp(rng, state));
    const before = structuredClone({ state, ops });
    applyDataOps(state, ops);
    expect({ state, ops }).toEqual(before);
  });

  seeded("is deterministic", (rng) => {
    const state = genState(rng);
    const ops = Array.from({ length: 1 + rng.int(5) }, () => genOp(rng, state));
    expect(applyDataOps(state, ops)).toEqual(applyDataOps(state, ops));
  });

  seeded("composes: apply(apply(s, a), b) equals apply(s, a ++ b)", (rng) => {
    const shaped = rng.chance(0.8);
    const shape = genShape(rng);
    const state: DataOpsCurrent = shaped
      ? { exists: true, value: shape as unknown as JsonValue }
      : genState(rng);
    const a = shaped ? genValidRun(rng, shape, rng.int(4)).ops : [];
    if (rng.chance(0.3)) a.push(genOp(rng, state));
    const first = applyDataOps(state, a);
    const b = Array.from({ length: 1 + rng.int(3) }, () =>
      genOp(rng, first.ok && first.exists ? first : { exists: false }),
    );
    const whole = applyDataOps(state, [...a, ...b]);
    if (!first.ok) {
      expect(whole).toEqual(first);
      return;
    }
    const second = applyDataOps(
      first.exists ? { exists: true, value: first.value } : { exists: false },
      b,
    );
    if (second.ok) expect(whole).toEqual(second);
    else {
      expect(whole.ok).toBe(false);
      if (!whole.ok)
        expect(whole.error).toEqual({
          ...second.error,
          opIndex: a.length + second.error.opIndex,
        });
    }
  });

  seeded("is atomic: a failing op yields its index and no value", (rng) => {
    const shape = genShape(rng);
    const state: DataOpsCurrent = {
      exists: true,
      value: shape as unknown as JsonValue,
    };
    const length = 1 + rng.int(4);
    const { ops } = genValidRun(rng, shape, length);
    expect(ops).toHaveLength(length);
    const failing: DataOp = { op: "insert", index: 100000, value: 1 };
    const result = applyDataOps(state, [...ops, failing, genOp(rng, state)]);
    expect(result.ok).toBe(false);
    expect(result).not.toHaveProperty("value");
    expect(result).not.toHaveProperty("exists");
    if (!result.ok) expect(result.error.opIndex).toBe(ops.length);
  });

  it("keeps inc results inside the bounds and matches the reference", () => {
    const seen = { clamped: 0, rejected: 0, inRange: 0, absentStart: 0 };
    for (let c = 0; c < CASES; c++) {
      const seed = 1000 + c;
      const rng = makeRng(seed);
      const min = rng.int(10) - 5;
      const max = min + rng.int(8);
      const absent = rng.chance(0.2);
      let n = absent ? 0 : rng.int(40) - 20;
      let state: DataOpsCurrent = absent
        ? { exists: false }
        : { exists: true, value: { n } };
      if (absent) seen.absentStart++;
      const onBound = rng.pick(["reject", "clamp", undefined] as const);
      for (let i = 1 + rng.int(4); i > 0; i--) {
        const by = rng.int(21) - 10;
        const op: DataOp = {
          op: "inc",
          path: "/n",
          by,
          min,
          max,
          ...(onBound ? { onBound } : {}),
        };
        const raw = n + by;
        const inRange = raw >= min && raw <= max;
        const result = applyDataOps(state, [op]);
        if (inRange) {
          seen.inRange++;
          expect(result, `seed ${seed}`).toEqual({
            ok: true,
            exists: true,
            value: { n: raw },
          });
        } else if (onBound === "clamp") {
          seen.clamped++;
          const clamped = raw < min ? min : max;
          expect(result, `seed ${seed}`).toEqual({
            ok: true,
            exists: true,
            value: { n: clamped },
          });
        } else {
          seen.rejected++;
          expect(result.ok, `seed ${seed}`).toBe(false);
          if (!result.ok) expect(result.error.code).toBe("out-of-bounds");
          break;
        }
        n = (result as unknown as { value: { n: number } }).value.n;
        expect(n).toBeGreaterThanOrEqual(min);
        expect(n).toBeLessThanOrEqual(max);
        state = { exists: true, value: { n } };
      }
    }
    expect(seen.inRange).toBeGreaterThan(100);
    expect(seen.clamped).toBeGreaterThan(100);
    expect(seen.rejected).toBeGreaterThan(50);
    expect(seen.absentStart).toBeGreaterThan(50);
  });

  it("rejects inc on a non-number target with type-mismatch", () => {
    for (let c = 0; c < CASES; c++) {
      const rng = makeRng(1000 + c);
      const target = rng.pick<JsonValue>([
        "1",
        null,
        true,
        [],
        { a: 1 },
        genPrimitive(rng) === 0 ? "0" : "q",
      ]);
      const result = applyDataOps({ exists: true, value: { n: target } }, [
        { op: "inc", path: "/n", by: 1, onBound: "clamp" },
      ]);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe("type-mismatch");
    }
  });

  seeded("valid runs succeed, match the reference and survive JSON", (rng) => {
    const shape = genShape(rng);
    const length = 1 + rng.int(6);
    const { ops, end } = genValidRun(rng, shape, length);
    expect(ops).toHaveLength(length);
    const result = applyDataOps(
      { exists: true, value: shape as unknown as JsonValue },
      ops,
    );
    expect(result).toEqual({
      ok: true,
      exists: true,
      value: end,
    });
    if (!result.ok || !result.exists) return;
    expect(JSON.parse(JSON.stringify(result.value))).toEqual(result.value);
  });

  seeded("a valid run starting absent succeeds after a set", (rng) => {
    const shape = genShape(rng);
    const { ops, end } = genValidRun(rng, shape, 1 + rng.int(4));
    const result = applyDataOps({ exists: false }, [
      { op: "set", value: shape as unknown as JsonValue },
      ...ops,
    ]);
    expect(result).toEqual({ ok: true, exists: true, value: end });
  });
});
