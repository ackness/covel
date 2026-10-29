/**
 * What a suspension's buffered writes would overwrite: a resume must not put
 * back a stale whole value, so whole-value writes are digested. Relative
 * operations apply to the latest value and are left out.
 */

import { describe, expect, it } from "vitest";
import type { DataOp } from "@covel/shared";
import { suspensionWriteTargets } from "../src/resume/suspension-baseline.js";

const update = (ops: readonly DataOp[], key = "gold") => ({
  id: crypto.randomUUID(),
  type: "plugin.data.update",
  source: { pluginId: "bank", runtimeId: "bank/main" },
  sessionId: "s",
  turnId: "t",
  payload: { namespace: "wallet", key, ops },
  timestamp: "2026-10-29T00:00:00.000Z",
});

const target = (key = "gold") => ({
  kind: "plugin-data",
  pluginId: "bank",
  namespace: "wallet",
  key,
});

describe("suspensionWriteTargets and plugin.data.update", () => {
  it("adds no target for relative operations only", () => {
    expect(
      suspensionWriteTargets([
        update([
          { op: "inc", by: 1 },
          { op: "merge", value: { a: 1 } },
          { op: "append", value: 1 },
          { op: "upsertItem", key: "id", value: { id: "a" } },
        ]),
      ]),
    ).toEqual([]);
  });

  it("adds a target when the operations contain set or delete", () => {
    expect(
      suspensionWriteTargets([
        update(
          [
            { op: "inc", by: 1 },
            { op: "set", value: 3 },
          ],
          "a",
        ),
        update([{ op: "delete" }], "b"),
      ]),
    ).toEqual([target("a"), target("b")]);
  });

  it("adds a key once next to a whole-value write", () => {
    expect(
      suspensionWriteTargets([
        update([{ op: "set", value: 1 }]),
        {
          ...update([]),
          type: "plugin.data",
          payload: { namespace: "wallet", key: "gold", value: 2 },
        },
      ]),
    ).toEqual([target()]);
  });

  it("ignores a malformed op list", () => {
    expect(
      suspensionWriteTargets([
        { ...update([]), payload: { namespace: "wallet", key: "gold" } },
        {
          ...update([]),
          payload: { namespace: "wallet", key: "gold", ops: [null] },
        },
      ]),
    ).toEqual([]);
  });
});
