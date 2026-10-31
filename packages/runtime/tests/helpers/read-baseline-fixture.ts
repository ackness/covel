import { afterEach, vi } from "vitest";
import type { DataStore } from "@covel/store";
import { createMemoryStore } from "@covel/store/memory";
import type { RuntimeManifest } from "@covel/shared";
import type { FunctionHandler } from "@covel/shared/plugin-runtime";
import { commitExecution, executeTurn } from "../../src/index.js";

const opened: DataStore[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(opened.splice(0).map((store) => store.close()));
});

export async function readBaselineFixture(
  create: () => DataStore = createMemoryStore,
) {
  const store = create();
  opened.push(store);
  const now = "2026-10-30T00:00:00.000Z";
  await store.createSession({
    id: "session",
    locale: "en",
    status: "active",
    phase: "playing",
    setupRuntimes: {},
    seats: [],
    activePlugins: ["writer"],
    completedPlayerTurns: 0,
    createdAt: now,
    updatedAt: now,
  });
  const set = (value: unknown, key = "record") =>
    store.setPluginData({
      id: `row:${key}`,
      sessionId: "session",
      pluginId: "writer",
      namespace: "data",
      key,
      value,
      createdAt: now,
      updatedAt: now,
    });
  await set({ score: 10, bar: 110 });
  const manifest = {
    name: "writer",
    pluginId: "writer",
    runtimeType: "function",
    stage: "post-turn",
    outputKind: "system",
    trigger: { type: "auto" },
  } as RuntimeManifest;
  let seq = 0;
  const prepare = (
    handler: FunctionHandler,
    options: {
      manifest?: RuntimeManifest;
      deps?: Partial<Parameters<typeof executeTurn>[2]>;
    } = {},
  ) =>
    executeTurn(
      {
        sessionId: "session",
        turnId: `turn:${++seq}`,
        logicalTurnId: `logical:${seq}`,
        playerMessage: "Continue",
        origin: "player",
      },
      [options.manifest ?? manifest],
      {
        store,
        llm: { generate: vi.fn() } as never,
        loadRuntime: async () => ({
          manifest: options.manifest ?? manifest,
          promptTemplate: "",
          handler,
        }),
        ...options.deps,
      },
    );
  const commit = (
    execution: Parameters<typeof commitExecution>[0]["execution"],
    extra: Partial<Parameters<typeof commitExecution>[0]> = {},
  ) =>
    commitExecution({
      ...extra,
      store,
      execution,
      completion: {
        kind: "turn",
        turnId: execution.commit.results[0]!.turnId,
        durationMs: 0,
      },
    });
  const get = async (key = "record") =>
    (await store.getPluginData("session", "writer", "data", key))?.value;
  return { store, set, prepare, commit, get, manifest };
}
