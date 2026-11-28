import { describe, expect, it } from "vitest";
import {
  BranchNodeCycleError,
  BranchNodeNotFoundError,
  activeBranchPath,
  activeLeafFromNode,
  branchLorebookEntryKey,
  branchPathToNode,
  branchPluginDataKey,
  lowestCommonAncestor,
  materializeBranchState,
  type BranchBasePayload,
  type BranchTurnNode,
} from "@covel/runtime";

const base: BranchBasePayload = {
  session: {
    status: "active",
    phase: "playing",
    completedPlayerTurns: 0,
    setupRuntimes: {},
    seats: [],
    locale: "en",
    activePlugins: [],
    runtimeModelOverrides: {},
  },
  characterSchema: null,
  characters: [],
  pluginData: [],
  lorebookEntries: [],
  runtimeExports: [],
  suspensions: [],
  sessionSummaries: [],
  compactedMessageSummaryIds: {},
  messages: [],
  turnMessages: [],
  playerInputs: [],
  interactionRecords: [],
};

function node(
  id: string,
  parentNodeId: string | null,
  statePayload: BranchTurnNode["statePayload"],
  activeChildId: string | null = null,
  overrides: Partial<BranchTurnNode> = {},
): BranchTurnNode {
  return {
    id,
    parentNodeId,
    activeChildId,
    turnId: id,
    turnIds: [id],
    logicalTurn: id === "root" ? 0 : 1,
    seq: 0,
    checkpointKind: id === "root" ? "base" : "delta",
    baseNodeId: "root",
    depthFromBase: id === "root" ? 0 : 1,
    statePayload,
    ...overrides,
  };
}

describe("turn branch helpers", () => {
  it("returns root-to-node paths, active paths, and common ancestors", () => {
    const nodes = [
      node("root", null, base, "left"),
      node("left", "root", {}, "leaf"),
      node("right", "root", {}),
      node("leaf", "left", {}),
    ];

    expect(branchPathToNode(nodes, "leaf").map((item) => item.id)).toEqual([
      "root",
      "left",
      "leaf",
    ]);
    expect(activeBranchPath(nodes, null)).toEqual([]);
    expect(activeBranchPath(nodes, "left").map((item) => item.id)).toEqual([
      "root",
      "left",
    ]);
    expect(lowestCommonAncestor(nodes, "leaf", "right").id).toBe("root");
    expect(activeLeafFromNode(nodes, "root").id).toBe("leaf");
  });

  it("rejects missing nodes, parent cycles, active-child cycles, non-child links, and disjoint roots", () => {
    const missingParent = [node("child", "missing", {})];
    expect(() => branchPathToNode(missingParent, "unknown")).toThrow(
      BranchNodeNotFoundError,
    );
    expect(() => branchPathToNode(missingParent, "child")).toThrow(
      BranchNodeNotFoundError,
    );

    const parentCycle = [node("a", "b", {}), node("b", "a", {})];
    expect(() => branchPathToNode(parentCycle, "a")).toThrow(
      BranchNodeCycleError,
    );

    const activeCycle = [node("a", "b", {}, "b"), node("b", "a", {}, "a")];
    expect(() => activeLeafFromNode(activeCycle, "a")).toThrow(
      BranchNodeCycleError,
    );

    const missingActiveChild = [node("root", null, base, "gone")];
    expect(() => activeLeafFromNode(missingActiveChild, "root")).toThrow(
      BranchNodeNotFoundError,
    );

    const nonChildActive = [
      node("root", null, base, "other"),
      node("other", null, base),
    ];
    expect(() => activeLeafFromNode(nonChildActive, "root")).toThrow(
      /non-child activeChildId/,
    );
    expect(() => lowestCommonAncestor(nonChildActive, "root", "other")).toThrow(
      /do not share a root/,
    );
  });

  it("applies deltas with composite keys for plugin data and lorebook entries without cross-owner collisions", () => {
    const worldEntry = {
      id: "shared-id",
      sessionId: "s",
      owner: { kind: "world" as const },
      keys: ["world"],
      content: "World lore",
      strategy: "constant" as const,
      position: "before_char",
      insertionOrder: 1,
      enabled: true,
      createdAt: "1",
      updatedAt: "1",
    };
    const pluginEntry = {
      id: "shared-id",
      sessionId: "s",
      owner: { kind: "plugin" as const, pluginId: "lore-mod" },
      keys: ["mod"],
      content: "Plugin lore",
      strategy: "selective" as const,
      position: "after_char",
      insertionOrder: 2,
      enabled: true,
      createdAt: "1",
      updatedAt: "1",
    };

    const updatedHero = {
      id: "hero",
      sessionId: "s",
      name: "New",
      type: "pc" as const,
      version: 2,
      createdAt: "1",
      updatedAt: "2",
    };
    const nodes = [
      node(
        "root",
        null,
        {
          ...base,
          characters: [
            {
              id: "hero",
              sessionId: "s",
              name: "Old",
              type: "pc",
              version: 1,
              createdAt: "1",
              updatedAt: "1",
            },
            {
              id: "removed",
              sessionId: "s",
              name: "Gone",
              type: "npc",
              version: 1,
              createdAt: "1",
              updatedAt: "1",
            },
          ],
          pluginData: [
            {
              id: "pd-1",
              sessionId: "s",
              pluginId: "mod",
              namespace: "stats",
              key: "hp",
              value: 10,
              createdAt: "1",
              updatedAt: "1",
            },
            {
              id: "pd-2",
              sessionId: "s",
              pluginId: "mod",
              namespace: "stats",
              key: "mp",
              value: 5,
              createdAt: "1",
              updatedAt: "1",
            },
          ],
          lorebookEntries: [worldEntry, pluginEntry],
        },
        "next",
        {
          tailDelta: {
            pluginData: {
              upserts: [
                {
                  id: "pd-1",
                  sessionId: "s",
                  pluginId: "mod",
                  namespace: "stats",
                  key: "hp",
                  value: 12,
                  createdAt: "1",
                  updatedAt: "1.5",
                },
              ],
              deletes: [branchPluginDataKey("mod", "stats", "mp")],
            },
          },
        },
      ),
      node(
        "next",
        "root",
        {
          session: { ...base.session, completedPlayerTurns: 1 },
          characters: {
            upserts: [updatedHero],
            deletes: ["removed"],
          },
          lorebookEntries: {
            upserts: [{ ...pluginEntry, content: "Updated plugin lore" }],
            deletes: [branchLorebookEntryKey({ kind: "world" }, "shared-id")],
          },
          messagesAdded: [
            {
              id: "m1",
              sessionId: "s",
              role: "user",
              content: "hello",
              createdAt: "2",
            },
          ],
        },
        null,
        {
          tailDelta: {
            messagesAdded: [
              {
                id: "m2",
                sessionId: "s",
                role: "assistant",
                content: "tail",
                createdAt: "3",
              },
            ],
          },
        },
      ),
    ];

    const state = materializeBranchState(nodes, "next");
    expect(state.session.completedPlayerTurns).toBe(1);
    expect(state.characters.map((c) => [c.id, c.name])).toEqual([
      ["hero", "New"],
    ]);
    expect(state.pluginData.map((row) => [row.key, row.value])).toEqual([
      ["hp", 12],
    ]);
    expect(state.lorebookEntries).toEqual([
      expect.objectContaining({
        id: "shared-id",
        owner: { kind: "plugin", pluginId: "lore-mod" },
        content: "Updated plugin lore",
      }),
    ]);
    expect(state.messages.map((message) => message.id)).toEqual(["m1", "m2"]);

    // Deep-clone isolation: mutating materialized state must not mutate input nodes.
    (state.characters[0] as { name: string }).name = "Mutated";
    expect(updatedHero.name).toBe("New");
  });

  it("starts from the closest ancestor base checkpoint and fails closed on corrupt payloads", () => {
    const secondBase: BranchBasePayload = {
      ...base,
      session: { ...base.session, completedPlayerTurns: 5 },
    };
    const nodes = [
      node("root", null, base, "mid"),
      node("mid", "root", secondBase, "leaf", {
        checkpointKind: "base",
        baseNodeId: "mid",
        depthFromBase: 0,
      }),
      node("leaf", "mid", {
        compactedMessageSummaryIds: { m1: "sum-1" },
      }),
    ];

    const state = materializeBranchState(nodes, "leaf");
    expect(state.session.completedPlayerTurns).toBe(5);
    expect(state.compactedMessageSummaryIds).toEqual({ m1: "sum-1" });

    expect(() =>
      materializeBranchState(
        [node("only-delta", null, {}, null, { checkpointKind: "delta" })],
        "only-delta",
      ),
    ).toThrow(/no base checkpoint/);

    expect(() =>
      materializeBranchState(
        [
          node("bad-base", null, null as unknown as BranchBasePayload, null, {
            checkpointKind: "base",
          }),
        ],
        "bad-base",
      ),
    ).toThrow(/Base checkpoint payload is incomplete/);

    expect(() =>
      materializeBranchState(
        [
          node("root", null, base, "bad-delta"),
          node(
            "bad-delta",
            "root",
            null as unknown as BranchBasePayload,
            null,
            { checkpointKind: "delta" },
          ),
        ],
        "bad-delta",
      ),
    ).toThrow(/Delta checkpoint payload is invalid/);
  });
});
