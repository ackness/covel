import { describe, expect, it } from "vitest";
import { createMemoryStore } from "@covel/store/memory";
import type { RuntimeManifest } from "@covel/shared";
import { executeTurn } from "../src/turn-executor/turn-executor.js";

describe("logical turn in handler context", () => {
  it("gives function handlers the scheduler's logical turn", async () => {
    const store = createMemoryStore();
    const now = "2026-10-02T00:00:00.000Z";
    await store.createSession({
      id: "s",
      status: "active",
      phase: "playing",
      completedPlayerTurns: 4,
      setupRuntimes: {},
      locale: "en-US",
      activePlugins: ["probe"],
      createdAt: now,
      updatedAt: now,
    });
    const manifest = {
      name: "probe/run",
      pluginId: "probe",
      description: "probe",
      stage: "pre-turn",
      runtimeType: "function",
      handler: "./handler.js",
      trigger: { type: "auto" },
    } as RuntimeManifest;
    let seen: unknown;
    await executeTurn(
      { sessionId: "s", turnId: "t", playerMessage: "go" },
      [manifest],
      {
        store,
        llm: {
          generate: async () => {
            throw new Error("function runtimes do not use the LLM");
          },
        },
        loadRuntime: async () => ({
          manifest,
          promptTemplate: "",
          handler: async (ctx) => {
            seen = ctx.logicalTurn;
            return { outcome: "success", value: {} };
          },
        }),
      },
    );
    expect(seen).toBe(5);
  });
});
