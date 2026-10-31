import { describe, expect, it } from "vitest";
import {
  resolveSessionPlugins,
  type SessionPluginCandidate,
} from "../src/plugin-selection.js";

const candidate = (
  id: string,
  extra: Partial<SessionPluginCandidate> = {},
): SessionPluginCandidate => ({
  id,
  kind: "plugin",
  source: "builtin",
  authorized: true,
  ...extra,
});
const receiver = (
  id = "receiver",
  extra: Partial<SessionPluginCandidate> = {},
) => candidate(id, { acceptsWorldData: ["notes@1"], ...extra });
const resolve = (
  plugins: SessionPluginCandidate[],
  extra: Partial<Parameters<typeof resolveSessionPlugins>[0]> = {},
) =>
  resolveSessionPlugins({
    requested: ["story"],
    requiredDataContracts: ["notes@1"],
    plugins: [candidate("story"), ...plugins],
    ...extra,
  });

describe("world data receiver selection", () => {
  it("adds a unique receiver with no runtimes and retains its dependencies", () => {
    const plan = resolve([
      receiver("receiver", { requires: ["storage@1"] }),
      candidate("storage", { provides: ["storage@1"] }),
    ]);
    expect(plan.active).toEqual(["story", "receiver", "storage"]);
    expect(plan.autoAdded).toEqual(["receiver", "storage"]);
    expect(plan.unmetData).toEqual([]);
  });
  it("does not confuse a schema publisher or capability provider with a receiver", () => {
    const plan = resolve([candidate("publisher", { provides: ["notes@1"] })]);
    expect(plan.active).toEqual(["story"]);
    expect(plan.unmetData).toEqual([
      { contract: "notes@1", code: "missing-provider" },
    ]);
    expect(
      resolve([receiver("receiver", { acceptsWorldData: [] })]).active,
    ).toEqual(["story"]);
  });
  it("keeps data acceptance separate from capability requirements", () => {
    expect(
      resolve([receiver()], { requiredContracts: ["notes@1"] }).unmet,
    ).toEqual([{ contract: "notes@1", code: "missing-provider" }]);
  });
  it("asks for a choice among several receivers, regardless of defaults", () => {
    const plugins = [
      receiver("left", { provides: [{ contract: "notes@1", default: true }] }),
      receiver("right"),
    ];
    expect(resolve(plugins).active).toEqual(["story"]);
    expect(resolve(plugins).unmetData[0]?.code).toBe("ambiguous-provider");
    expect(resolve(plugins, { requested: ["story", "right"] }).active).toEqual([
      "story",
      "right",
    ]);
    expect(
      resolve([receiver("left"), receiver("right")], {
        requested: ["story", "left", "right"],
      }).active,
    ).toEqual(["story", "left", "right"]);
  });
  it.each([
    [receiver(), { excluded: ["receiver"] }, "excluded"],
    [
      receiver("receiver", { source: "community", authorized: false }),
      {},
      "approval-required",
    ],
    [receiver("receiver", { requires: ["absent@1"] }), {}, "missing-provider"],
    [receiver("receiver", { conflicts: ["story@1"] }), {}, "missing-provider"],
  ] as const)(
    "leaves unrelated storytelling active when a receiver cannot join: %s",
    (plugin, options, code) => {
      const plan = resolve([plugin], {
        ...options,
        plugins: [candidate("story", { provides: ["story@1"] }), plugin],
      });
      expect(plan.active).toEqual(["story"]);
      expect(plan.unmetData[0]?.code).toBe(code);
    },
  );
  it("never adds a newly available receiver to a confirmed set", () => {
    expect(resolve([receiver()], { fixed: true }).active).toEqual(["story"]);
  });
});

it("limits live automatic additions without erasing receiver diagnostics", () => {
  const plan = resolve([receiver()], {
    automaticPluginIds: [],
    excluded: ["receiver"],
  });
  expect(plan.active).toEqual(["story"]);
  expect(plan.unmetData).toEqual([
    { contract: "notes@1", code: "excluded", candidates: ["receiver"] },
  ]);
  expect(resolve([receiver()], { automaticPluginIds: [] }).active).toEqual([
    "story",
  ]);
});

it("requires a player or pack selection for presentation receivers", () => {
  const presentation = receiver("presentation", {
    runtimes: [{ presentation: { budget: { calls: 0, generations: 0 } } }],
  });
  const automatic = resolve([presentation]);
  expect(automatic.active).toEqual(["story"]);
  expect(automatic.unmetData).toEqual([
    {
      contract: "notes@1",
      code: "missing-provider",
      candidates: ["presentation"],
    },
  ]);
  expect(
    resolve([presentation], { requested: ["story", "presentation"] }).active,
  ).toEqual(["story", "presentation"]);
  expect(resolve([receiver(), presentation]).active).toEqual([
    "story",
    "receiver",
  ]);
  expect(
    resolve([{ ...presentation, source: "community", authorized: false }])
      .rejected,
  ).toEqual([]);
});

it("does not add new world providers or core defaults during unrelated live changes", () => {
  const plan = resolveSessionPlugins({
    requested: ["story", "consumer"],
    automaticPluginIds: ["story", "consumer"],
    requiredContracts: ["world-feature@1"],
    plugins: [
      candidate("story"),
      candidate("consumer", { requires: ["storage@1"] }),
      candidate("storage", { provides: ["storage@1"] }),
      candidate("new-world-provider", { provides: ["world-feature@1"] }),
      candidate("new-core", { kind: "core" }),
    ],
  });
  expect(plan.active).toEqual(["story", "consumer", "storage"]);
  expect(plan.unmet).toEqual([
    {
      contract: "world-feature@1",
      code: "missing-provider",
      candidates: ["new-world-provider"],
    },
  ]);
});
