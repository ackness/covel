import { expect, it, vi } from "vitest";
import { createMemoryStore } from "@covel/store/memory";
import type { RuntimeManifest } from "@covel/shared";
import {
  commitExecution,
  createHookPipeline,
  executeTurn,
} from "../src/index.js";

it("only retains still-active execution hooks at commit and preserves their captured settings", async () => {
  const store = createMemoryStore();
  const timestamp = "2026-09-29T00:00:00.000Z";
  await store.createSession({
    id: "session",
    locale: "en-US",
    status: "active",
    phase: "playing",
    setupRuntimes: {},
    activePlugins: ["a", "b"],
    completedPlayerTurns: 0,
    createdAt: timestamp,
    updatedAt: timestamp,
  });
  const manifest: RuntimeManifest = {
    description: "test",
    name: "a/write",
    pluginId: "a",
    runtimeType: "function",
    stage: "narrative",
    outputKind: "plugin",
    trigger: { type: "auto" },
  };
  const hookPipeline = createHookPipeline();
  const observed: Array<{
    pluginId: string;
    event: string;
    settings: unknown;
  }> = [];
  for (const pluginId of ["a", "b", "c"]) {
    for (const event of ["PreStateCommit", "PostStateCommit"] as const) {
      hookPipeline.register({
        id: `${pluginId}:${event}`,
        pluginId,
        event,
        handler: async (context) => {
          const settings = context.getOwnSettings!();
          expect(Object.isFrozen(settings)).toBe(true);
          observed.push({ pluginId, event, settings });
          return { action: "continue" };
        },
      });
    }
  }
  const hookScope = {
    activePluginIds: new Set(["a", "b"]),
    settings: {
      a: { tone: "captured" },
      b: { tone: "disabled" },
      c: { tone: "newly-enabled" },
    },
  };
  let entered!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let finish!: () => void;
  const pending = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const running = executeTurn(
    {
      sessionId: "session",
      turnId: "turn",
      origin: "manual",
      playerMessage: "Save note",
    },
    [manifest],
    {
      store,
      hookScope,
      hookPipeline,
      llm: { generate: vi.fn() },
      loadRuntime: async () => ({
        manifest,
        promptTemplate: "",
        handler: async () => {
          entered();
          await pending;
          return {
            outcome: "success",
            value: { saved: true },
            effects: {
              pluginData: [
                { namespace: "notes", key: "current", value: "saved" },
              ],
            },
          };
        },
      }),
    },
  );
  await started;
  hookScope.settings.a.tone = "changed-during-execution";
  hookScope.activePluginIds.delete("b");
  hookScope.activePluginIds.add("c");
  await store.updateSession("session", { activePlugins: ["a", "c"] });
  finish();
  const execution = await running;
  expect([...execution.commit.activePluginIds!]).toEqual(["a", "b"]);
  expect(observed).toEqual([]);
  const outcome = await commitExecution({
    store,
    execution,
    hookPipeline,
    activePluginIds: new Set(["a", "c"]),
    completion: { kind: "turn", turnId: "turn", durationMs: 0 },
  });
  expect(outcome.status).toBe("committed");
  expect(observed).toEqual([
    { pluginId: "a", event: "PreStateCommit", settings: { tone: "captured" } },
    { pluginId: "a", event: "PostStateCommit", settings: { tone: "captured" } },
  ]);
  expect(
    (await store.getPluginData("session", "a", "notes", "current"))?.value,
  ).toBe("saved");
});
