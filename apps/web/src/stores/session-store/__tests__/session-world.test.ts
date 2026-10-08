// @vitest-environment node
import { describe, expect, it } from "vitest";
import type { SessionRecord, WorldRecord } from "@/services/api.js";
import { initialState, reducer } from "../reducer.js";
import type { SessionAction, SessionState } from "../types.js";

const world = (id: string): WorldRecord => ({
  id,
  name: id,
  description: "",
  createdAt: "2026-10-08T00:00:00Z",
});
const session = { id: "s1", worldId: "haruka" } as SessionRecord;
const boot = (worlds: WorldRecord[]): SessionAction => ({
  type: "BOOT_SUCCESS",
  presets: [],
  plugins: [],
  pluginLoadErrors: [],
  worlds,
  llmConfig: null,
});
const run = (state: SessionState, ...actions: SessionAction[]) =>
  actions.reduce(reducer, state);

describe("the world of a restored session", () => {
  it("comes from the catalog when the catalog loads after the session", () => {
    const state = run(
      initialState,
      { type: "SET_SESSION", session },
      boot([world("mistport"), world("haruka")]),
    );
    expect(state.world?.id).toBe("haruka");
  });

  it("comes from the catalog when the session is set after it loaded", () => {
    const state = run(
      { ...initialState, world: world("mistport") },
      boot([world("mistport"), world("haruka")]),
      { type: "SET_SESSION", session },
    );
    expect(state.world?.id).toBe("haruka");
  });

  it("keeps the world already set for the session", () => {
    const current = { ...world("haruka"), description: "edited" };
    const state = run(
      { ...initialState, world: current },
      { type: "SET_SESSION", session },
      boot([world("haruka")]),
    );
    expect(state.world).toBe(current);
  });
});
