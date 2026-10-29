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

/** Ops that each succeed on the state the previous ones left. */
function genValidRun(rng: Rng, start: DataOpsCurrent, length: number) {
  const ops: DataOp[] = [];
  let state = start;
  for (let tries = 0; ops.length < length && tries < length * 20; tries++) {
    const op = genOp(rng, state);
    const next = applyDataOps(state, [op]);
    if (!next.ok) continue;
    ops.push(op);
    state = next.exists
      ? { exists: true, value: next.value }
      : { exists: false };
  }
  return { ops, end: state };
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
    const state = genState(rng);
    const a = genValidRun(rng, state, rng.int(4)).ops;
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
    const state = genState(rng);
    const { ops } = genValidRun(rng, state, 1 + rng.int(4));
    const failing: DataOp = { op: "insert", index: 100000, value: 1 };
    const result = applyDataOps(state, [...ops, failing, genOp(rng, state)]);
    expect(result.ok).toBe(false);
    expect(result).not.toHaveProperty("value");
    expect(result).not.toHaveProperty("exists");
    if (!result.ok) expect(result.error.opIndex).toBe(ops.length);
  });

  seeded("keeps successful inc results inside the bounds", (rng) => {
    const min = rng.int(10) - 5;
    const max = min + rng.int(8);
    const start: DataOpsCurrent = rng.chance(0.2)
      ? { exists: false }
      : { exists: true, value: { n: rng.int(40) - 20 } };
    const onBound = rng.pick(["reject", "clamp", undefined] as const);
    const ops: DataOp[] = Array.from({ length: 1 + rng.int(4) }, () => ({
      op: "inc",
      path: "/n",
      by: rng.int(21) - 10,
      min,
      max,
      ...(onBound ? { onBound } : {}),
    }));
    let state = start;
    for (const op of ops) {
      const result = applyDataOps(state, [op]);
      if (!result.ok) {
        expect(
          result.error.code === "out-of-bounds" ||
            result.error.code === "type-mismatch",
        ).toBe(true);
        return;
      }
      const n = (result as unknown as { value: { n: number } }).value.n;
      expect(n).toBeGreaterThanOrEqual(min);
      expect(n).toBeLessThanOrEqual(max);
      state = { exists: true, value: { n } };
    }
  });

  seeded("returns values that survive a JSON round trip", (rng) => {
    const state = genState(rng);
    const { ops, end } = genValidRun(rng, state, 1 + rng.int(6));
    const result = applyDataOps(state, ops);
    expect(result.ok).toBe(true);
    if (!result.ok || !result.exists) return;
    expect(end.exists).toBe(true);
    expect(JSON.parse(JSON.stringify(result.value))).toEqual(result.value);
  });
});
