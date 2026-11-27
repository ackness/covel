import { describe, expect, it } from "vitest";
import {
  activeLeafFromNode,
  branchPathToNode,
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
  };
}

describe("turn branch helpers", () => {
  it("returns root-to-node paths and common ancestors", () => {
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
    expect(lowestCommonAncestor(nodes, "leaf", "right").id).toBe("root");
    expect(activeLeafFromNode(nodes, "root").id).toBe("leaf");
  });

  it("applies deltas while keeping collection replacement and append semantics", () => {
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
          ],
        },
        "next",
      ),
      node("next", "root", {
        characters: {
          upserts: [
            {
              id: "hero",
              sessionId: "s",
              name: "New",
              type: "pc",
              version: 2,
              createdAt: "1",
              updatedAt: "2",
            },
          ],
          deletes: [],
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
      }),
    ];

    const state = materializeBranchState(nodes, "next");
    expect(state.characters[0]?.name).toBe("New");
    expect(state.messages.map((message) => message.id)).toEqual(["m1"]);
  });
});
