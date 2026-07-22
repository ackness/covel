import { describe, it, expect } from "vitest";
import handler from "../handler.js";

function makeStore(overrides = {}) {
  return {
    async getSession() {
      return { worldId: "w1" };
    },
    async getWorld() {
      return { name: "雾港", description: "被海雾环绕的港口城市" };
    },
    ...overrides,
  };
}

// Deliberate change: handler migrated to envelope-v1. Business value (narrative
// / initialized) is under `result.value`, notifications under `result.effects`,
// and the pre-game completion signal is `result.completion === "done"` (the
// kernel projects it to the legacy top-level preGameDone).
describe("pregame handler", () => {
  it("builds a localized welcome from world data and reports preGameDone", async () => {
    const result = await handler({
      sessionId: "sess-1",
      locale: "zh-CN",
      store: makeStore(),
    });

    expect(result.completion).toBe("done");
    expect(result.value.initialized).toBe(true);
    expect(result.value.narrativeOutput).toContain("雾港");
    expect(result.value.narrativeOutput).toContain("被海雾环绕的港口城市");
    expect(result.effects.notifications).toHaveLength(1);
    expect(result.effects.notifications[0].title).toContain("欢迎来到雾港");
  });

  it("falls back to locale defaults when no store is available", async () => {
    const result = await handler({
      sessionId: "sess-1",
      locale: "en",
      store: undefined,
    });

    expect(result.completion).toBe("done");
    expect(result.effects.notifications[0].title).toContain(
      "Welcome to Unknown World",
    );
    expect(result.value.narrativeOutput).toContain("Game initialized");
  });

  it("survives a throwing store instead of failing pre-game", async () => {
    const result = await handler({
      sessionId: "sess-1",
      locale: "zh",
      store: {
        async getSession() {
          throw new Error("boom");
        },
      },
    });

    expect(result.completion).toBe("done");
    expect(result.value.narrativeOutput).toContain("未知世界");
  });

  it("treats a session without worldId as an unknown world", async () => {
    const result = await handler({
      sessionId: "sess-1",
      locale: "en-US",
      store: makeStore({
        async getSession() {
          return {};
        },
      }),
    });

    expect(result.completion).toBe("done");
    expect(result.effects.notifications[0].title).toContain("Unknown World");
  });
});
