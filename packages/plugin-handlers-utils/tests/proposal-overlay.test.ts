// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  overlayPluginDataRows,
  overlayPluginDataValue,
  type DataOp,
  type PluginProposal,
  type PluginProposalPayloads,
  type PluginProposalType,
} from "../src/index.js";

function proposal<K extends PluginProposalType>(
  type: K,
  payload: PluginProposalPayloads[K],
  pluginId = "probe",
): PluginProposal {
  return {
    id: `${type}-${Math.round(performance.now() * 1000)}`,
    type,
    source: { pluginId, runtimeId: `${pluginId}/main` },
    sessionId: "s",
    turnId: "t",
    payload,
    timestamp: "2026-10-29T00:00:00.000Z",
  } as PluginProposal;
}

const set = (value: unknown, key = "gold", namespace = "wallet") =>
  proposal("plugin.data", { namespace, key, value });
const del = (key = "gold", namespace = "wallet") =>
  proposal("plugin.data.delete", { namespace, key });
const update = (ops: readonly DataOp[], key = "gold", namespace = "wallet") =>
  proposal("plugin.data.update", { namespace, key, ops });
const value = (
  proposals: readonly PluginProposal[],
  base: Parameters<typeof overlayPluginDataValue>[4] = { exists: false },
  pluginId = "probe",
) => overlayPluginDataValue(proposals, pluginId, "wallet", "gold", base);

describe("overlayPluginDataValue", () => {
  it("applies writes in order over the base", () => {
    expect(
      value(
        [
          update([{ op: "inc", by: 2 }]),
          set(10),
          update([{ op: "inc", by: -3 }]),
        ],
        { exists: true, value: 1 },
      ),
    ).toEqual({ hit: true, exists: true, value: 7 });
  });

  it("skips an update whose ops fail and keeps the state before it", () => {
    expect(
      value(
        [
          update([{ op: "inc", by: -5, min: 0 }]),
          update([{ op: "inc", by: 1 }]),
        ],
        { exists: true, value: 2 },
      ),
    ).toEqual({ hit: true, exists: true, value: 3 });
  });

  it("starts an update after a delete from absent", () => {
    expect(
      value([del(), update([{ op: "append", value: "x" }])], {
        exists: true,
        value: ["old"],
      }),
    ).toEqual({ hit: true, exists: true, value: ["x"] });
    expect(
      value([update([{ op: "delete" }])], { exists: true, value: 1 }),
    ).toEqual({ hit: true, exists: false });
  });

  it("reports hit whenever a write targets the key", () => {
    const base = { exists: true, value: 4 } as const;
    expect(value([], base)).toEqual({ hit: false, exists: true, value: 4 });
    expect(value([set(1, "other")], base)).toEqual({
      hit: false,
      exists: true,
      value: 4,
    });
    expect(value([update([{ op: "inc", by: 1, max: 4 }])], base)).toEqual({
      hit: true,
      exists: true,
      value: 4,
    });
    expect(value([del()], { exists: false })).toEqual({
      hit: true,
      exists: false,
    });
  });

  it("reads batch items and ignores other plugins' proposals", () => {
    expect(
      value(
        [
          proposal("plugin.data.batch", {
            items: [
              { namespace: "wallet", key: "gold", value: 1 },
              { namespace: "wallet", key: "gold", value: 2 },
            ],
          }),
          update([{ op: "inc", by: 100 }], "gold", "wallet"),
          proposal(
            "plugin.data.update",
            {
              namespace: "wallet",
              key: "gold",
              ops: [{ op: "set", value: 0 }],
            },
            "other",
          ),
        ],
        { exists: false },
      ),
    ).toEqual({ hit: true, exists: true, value: 102 });
  });

  it("does not mutate the base or the proposals", () => {
    const base = { exists: true as const, value: { list: [1] } };
    const ops: DataOp[] = [{ op: "append", path: "/list", value: 2 }];
    const result = value([update(ops)], base);
    expect(result).toEqual({
      hit: true,
      exists: true,
      value: { list: [1, 2] },
    });
    expect(base.value).toEqual({ list: [1] });
    expect(ops).toEqual([{ op: "append", path: "/list", value: 2 }]);
  });
});

describe("overlayPluginDataRows", () => {
  const rows = (
    proposals: readonly PluginProposal[],
    namespace?: string,
    base?: Parameters<typeof overlayPluginDataRows>[3],
  ) => [
    ...overlayPluginDataRows(proposals, "probe", namespace, base).entries(),
  ];

  it("starts an update from the base row, else absent", () => {
    expect(
      rows(
        [
          update([{ op: "inc", by: 1 }], "a"),
          update([{ op: "inc", by: 1 }], "b"),
        ],
        undefined,
        [{ namespace: "wallet", key: "a", value: 10 }],
      ),
    ).toEqual([
      [
        JSON.stringify(["wallet", "a"]),
        { namespace: "wallet", key: "a", value: 11 },
      ],
      [
        JSON.stringify(["wallet", "b"]),
        { namespace: "wallet", key: "b", value: 1 },
      ],
    ]);
  });

  it("starts an update from the latest buffered value, and from absent after a delete", () => {
    expect(
      rows(
        [
          set(5, "a"),
          update([{ op: "inc", by: 1 }], "a"),
          del("b"),
          update([{ op: "append", value: 1 }], "b"),
        ],
        undefined,
        [
          { namespace: "wallet", key: "a", value: 100 },
          { namespace: "wallet", key: "b", value: [0] },
        ],
      ).map(([, row]) => row),
    ).toEqual([
      { namespace: "wallet", key: "a", value: 6 },
      { namespace: "wallet", key: "b", value: [1] },
    ]);
  });

  it("marks a key an update deletes, and leaves out a skipped update", () => {
    expect(
      rows(
        [
          update([{ op: "delete" }], "a"),
          update([{ op: "inc", by: -1, min: 0 }], "b"),
        ],
        undefined,
        [
          { namespace: "wallet", key: "a", value: 1 },
          { namespace: "wallet", key: "b", value: 0 },
        ],
      ).map(([, row]) => row),
    ).toEqual([{ namespace: "wallet", key: "a", value: null, deleted: true }]);
  });

  it("filters by namespace and ignores other plugins", () => {
    expect(
      rows(
        [
          update([{ op: "inc", by: 1 }], "a", "wallet"),
          update([{ op: "inc", by: 1 }], "a", "bag"),
          proposal(
            "plugin.data.update",
            { namespace: "wallet", key: "z", ops: [{ op: "inc", by: 1 }] },
            "other",
          ),
        ],
        "wallet",
      ).map(([, row]) => row),
    ).toEqual([{ namespace: "wallet", key: "a", value: 1 }]);
  });
});
