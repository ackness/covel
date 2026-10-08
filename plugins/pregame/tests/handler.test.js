import { describe, it, expect } from "vitest";
import handler from "../handler.js";
import { loadPluginMessages } from "@covel/plugin-test-utils";

// What the host gives a handler as `ctx.messages` for a Chinese session.
const messages = await loadPluginMessages(
  new URL("..", import.meta.url),
  "zh-CN",
);

function makeStore(overrides = {}) {
  return {
    async getSession() {
      return { worldId: "w1" };
    },
    ...overrides,
  };
}

const world = {
  worldRecord: { name: "雾港", description: "被海雾环绕的港口城市" },
};

// Deliberate change: handler returns the canonical HandlerResult. Business value (narrative
// / initialized) is under `result.value`, notifications under `result.effects`,
// and the setup completion signal is `result.completion === "done"`.
describe("pregame handler", () => {
  it("builds a localized welcome from world data and reports preGameDone", async () => {
    const result = await handler({
      sessionId: "sess-1",
      locale: "zh-CN",
      messages,
      store: makeStore(),
      world,
    });

    expect(result.completion).toBe("done");
    expect(result.value.initialized).toBe(true);
    expect(result.value.narrativeOutput).toContain("雾港");
    expect(result.value.narrativeOutput).toContain("被海雾环绕的港口城市");
    expect(result.effects.notifications).toHaveLength(1);
    expect(result.effects.notifications[0].title).toContain("欢迎来到雾港");
  });

  it("does not welcome again when setup reruns in a playing session", async () => {
    const result = await handler({
      sessionId: "sess-1",
      locale: "zh-CN",
      messages,
      store: makeStore({
        async getSession() {
          return { worldId: "w1", phase: "playing" };
        },
      }),
      world,
    });

    expect(result.completion).toBe("done");
    expect(result.value).toEqual({ narrativeOutput: "", initialized: true });
    expect(result.effects).toBeUndefined();
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
      messages,
      store: {
        async getSession() {
          throw new Error("boom");
        },
      },
    });

    expect(result.completion).toBe("done");
    expect(result.value.narrativeOutput).toContain("未知世界");
  });

  it("treats a session without a world record as an unknown world", async () => {
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
