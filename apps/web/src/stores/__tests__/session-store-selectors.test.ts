import { describe, expect, it } from "vitest";
import type { SessionRecord } from "@/services/api";
import { canRunSessionAction } from "../session-store/selectors.js";
import type { SessionState } from "../session-store/types.js";

const baseSession: SessionRecord = {
  id: "session-1",
  worldId: "world-1",
  status: "active",
  turnCount: 1,
  preGameCompleted: [],
  activePlugins: [],
  createdAt: "2026-05-23T00:00:00.000Z",
};

function stateFor(
  overrides: Partial<Pick<SessionState, "executing" | "session">> = {},
): SessionState {
  return {
    presets: [],
    packages: [],
    pluginLoadErrors: [],
    commands: [],
    worlds: [],
    llmConfig: null,
    booted: true,
    bootError: null,
    sessionPlugins: [],
    world: null,
    session: baseSession,
    messages: [],
    worldSessions: [],
    executing: false,
    executionError: null,
    executionSteps: [],
    suspensions: [],
    statePatches: [],
    gameState: {},
    pluginData: {},
    messageUiSpecs: [],
    pendingInteractionDrafts: [],
    assetsByTurn: new Map(),
    assetProgressByTurn: new Map(),
    submittedBlockIds: new Set(),
    submittedBlockValues: {},
    ...overrides,
  };
}

describe("session-store selectors", () => {
  it("allows actions for active idle sessions", () => {
    expect(canRunSessionAction(stateFor())).toBe(true);
  });

  it("blocks actions while executing", () => {
    expect(canRunSessionAction(stateFor({ executing: true }))).toBe(false);
  });

  it("blocks actions without an active session", () => {
    expect(canRunSessionAction(stateFor({ session: null }))).toBe(false);
  });

  it("blocks actions for paused and ended sessions", () => {
    expect(
      canRunSessionAction(
        stateFor({ session: { ...baseSession, status: "paused" } }),
      ),
    ).toBe(false);
    expect(
      canRunSessionAction(
        stateFor({ session: { ...baseSession, status: "ended" } }),
      ),
    ).toBe(false);
  });
});
