import { describe, expect, it } from "vitest";
import {
  checkCollection,
  collectionPluginFacts,
  collectionWorldFacts,
  type CollectionPluginFacts,
} from "../src/collection-check.js";

describe("collection plugin contract completeness", () => {
  const consumer = collectionPluginFacts({
    id: "observer",
    requires: ["narrative-engine@2"],
  });

  it("reports a missing plugin requirement even without a world", () => {
    expect(
      checkCollection({ worlds: [], plugins: [consumer], available: [] }),
    ).toEqual([
      {
        level: "error",
        packageId: "observer",
        message:
          "Plugin observer requires narrative-engine@2, and no installed or included plugin provides it.",
      },
    ]);
  });

  it.each(["included", "installed"])("accepts an %s provider", (source) => {
    const provider = collectionPluginFacts({
      id: "story",
      provides: [{ contract: "narrative-engine@2" }],
    });
    expect(
      checkCollection({
        worlds: [],
        plugins: source === "included" ? [consumer, provider] : [consumer],
        available: source === "installed" ? [provider] : [],
      }),
    ).toEqual([]);
  });

  it("requires the exact contract version and checks every included plugin", () => {
    const observer: CollectionPluginFacts = {
      ...consumer,
      id: "second-observer",
    };
    expect(
      checkCollection({
        worlds: [],
        plugins: [consumer, observer],
        available: [{ id: "story", contracts: ["narrative-engine@3"] }],
      }),
    ).toEqual([
      expect.objectContaining({ level: "error", packageId: "observer" }),
      expect.objectContaining({ level: "error", packageId: "second-observer" }),
    ]);
  });
});

describe("world collection selection", () => {
  const packs: import("../src/index.js").PluginPack[] = [
    {
      id: "initial",
      label: "Initial",
      requested: ["missing"],
      recommended: [],
      tags: [],
      source: "builtin",
    },
    {
      id: "alternative",
      label: "Alternative",
      requested: ["other-missing"],
      recommended: [],
      tags: [],
      source: "builtin",
    },
  ];
  it("checks the initial pack with provenance and keeps alternatives inactive", () => {
    const world = collectionWorldFacts(
      { id: "world", plugins: ["pack:initial", "pack:alternative"] },
      packs,
    );
    expect(
      checkCollection({ worlds: [world], plugins: [], available: [] }),
    ).toEqual([
      expect.objectContaining({
        level: "warning",
        path: "plugins[0]",
        packId: "initial",
        message: expect.stringContaining("missing,"),
      }),
    ]);
  });
  it("satisfies an explicit world contract with an included provider", () => {
    const world = collectionWorldFacts(
      { id: "world", plugins: ["contract:check@1"] },
      packs,
    );
    expect(
      checkCollection({
        worlds: [world],
        plugins: [{ id: "dice", contracts: ["check@1"] }],
        available: [],
      }),
    ).toEqual([]);
  });
  it("locates malformed and unknown references", () => {
    const malformed = collectionWorldFacts(
      { id: "world", plugins: ["plugin:valid", "bare"] },
      packs,
    );
    const unknown = collectionWorldFacts(
      { id: "world", plugins: ["pack:absent"] },
      packs,
    );
    expect(
      checkCollection({
        worlds: [malformed, unknown],
        plugins: [],
        available: [],
      }),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ level: "error", path: "plugins[1]" }),
        expect.objectContaining({
          level: "warning",
          path: "plugins[0]",
          packId: "absent",
        }),
      ]),
    );
  });
  it("counts an installed provider included for update only once", () => {
    const provider = { id: "dice", contracts: ["check@1"] };
    const world = collectionWorldFacts(
      { id: "world", plugins: ["contract:check@1"] },
      packs,
    );
    expect(
      checkCollection({
        worlds: [world],
        plugins: [provider],
        available: [provider],
      }),
    ).toEqual([]);
  });
  it("does not satisfy a world contract with a provision removed by an included update", () => {
    const world = collectionWorldFacts(
      { id: "world", plugins: ["contract:check@1"] },
      packs,
    );
    expect(
      checkCollection({
        worlds: [world],
        plugins: [{ id: "dice", contracts: [] }],
        available: [{ id: "dice", contracts: ["check@1"] }],
      }),
    ).toEqual([
      expect.objectContaining({
        level: "warning",
        message: expect.stringContaining(
          "no installed or included plugin provides",
        ),
      }),
    ]);
  });
  it("preserves duplicate member and host version checks", () => {
    const plugin = { id: "dice", contracts: [], hostRange: ">=99.0.0" };
    expect(
      checkCollection({
        worlds: [],
        plugins: [plugin, plugin],
        available: [],
        hostVersion: "1.0.0",
      }),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          level: "error",
          message: expect.stringContaining("needs Covel"),
        }),
        expect.objectContaining({
          level: "error",
          message: expect.stringContaining("more than once"),
        }),
      ]),
    );
  });
});

describe("collection data receivers", () => {
  const world = {
    id: "world",
    requires: [],
    requested: [],
    requiredDataContracts: ["notes@1"],
  };
  const receiver = {
    id: "receiver",
    contracts: [],
    acceptsWorldData: ["notes@1"],
  };
  it("accepts a declared receiver and disregards a publisher-only decoy", () => {
    expect(
      checkCollection({
        worlds: [world],
        plugins: [receiver, { id: "publisher", contracts: ["notes@1"] }],
        available: [],
      }),
    ).toEqual([]);
    expect(
      checkCollection({
        worlds: [world],
        plugins: [{ id: "publisher", contracts: ["notes@1"] }],
        available: [],
      }),
    ).toEqual([
      expect.objectContaining({
        level: "warning",
        message: expect.stringContaining("no eligible receiver"),
      }),
    ]);
  });
  it("keeps ambiguity and exclusions visible without inventing missing content", () => {
    const plugins = [receiver, { ...receiver, id: "other" }];
    expect(
      checkCollection({ worlds: [world], plugins, available: [] }),
    ).toEqual([
      expect.objectContaining({
        message: expect.stringContaining("several receivers"),
      }),
    ]);
    expect(
      checkCollection({
        worlds: [{ ...world, requested: ["receiver"] }],
        plugins,
        available: [],
      }),
    ).toEqual([]);
    expect(
      checkCollection({
        worlds: [{ ...world, excluded: ["receiver", "other"] }],
        plugins,
        available: [],
      }),
    ).toEqual([
      expect.objectContaining({ message: expect.stringContaining("excluded") }),
    ]);
    expect(
      checkCollection({
        worlds: [{ ...world, requiredDataContracts: [] }],
        plugins: [],
        available: [],
      }),
    ).toEqual([]);
  });
  it("checks ordinary receiver dependencies before considering data received", () => {
    expect(
      checkCollection({
        worlds: [world],
        plugins: [],
        available: [{ ...receiver, requires: ["storage@1"] }],
      }),
    ).toEqual([
      expect.objectContaining({
        message: expect.stringContaining("no eligible receiver"),
      }),
    ]);
  });
});

it("requires an explicit collection selection for a presentation data receiver", () => {
  const world = {
    id: "world",
    requires: [],
    requested: [],
    requiredDataContracts: ["images@1"],
  };
  const receiver = {
    id: "display",
    contracts: [],
    acceptsWorldData: ["images@1"],
    runtimes: [{ presentation: { budget: { calls: 0, generations: 0 } } }],
  };
  expect(
    checkCollection({ worlds: [world], plugins: [receiver], available: [] }),
  ).toEqual([
    expect.objectContaining({
      level: "warning",
      message: expect.stringContaining("no eligible receiver"),
    }),
  ]);
  expect(
    checkCollection({
      worlds: [{ ...world, requested: ["display"] }],
      plugins: [receiver],
      available: [],
    }),
  ).toEqual([]);
});
