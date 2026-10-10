import { describe, expect, it, vi } from "vitest";
import { createMemoryStore } from "@covel/store/memory";
import {
  makeProposal,
  withPendingProposals,
} from "@covel/plugin-handlers-utils";
import type { RuntimeManifest } from "@covel/shared";
import type { LoadedRuntime } from "@covel/shared/plugin-runtime";
import {
  executeTurn,
  commitExecution,
  finalizeExecution,
} from "../src/index.js";

const timestamp = "2026-09-29T00:00:00.000Z";
const input = {
  sessionId: "s",
  turnId: "t",
  logicalTurnId: "logical-t",
  playerMessage: "Continue",
  origin: "player" as const,
};
const schema = {
  type: "object",
  properties: { text: { type: "string" } },
  required: ["text"],
};
function manifest(
  name: string,
  extra: Partial<RuntimeManifest> = {},
): RuntimeManifest {
  return {
    name,
    pluginId: "probe",
    description: name,
    runtimeType: "function",
    stage: "narrative",
    trigger: { type: "auto" },
    ...extra,
  };
}
async function fixture() {
  const store = createMemoryStore();
  await store.createSession({
    id: "s",
    locale: "en-US",
    status: "active",
    phase: "playing",
    setupRuntimes: {},
    activePlugins: ["probe"],
    completedPlayerTurns: 0,
    createdAt: timestamp,
    updatedAt: timestamp,
  });
  return store;
}

describe("prepared execution host API", () => {
  it("carries nested commands, journal and loaded schemas through a copied plan", async () => {
    const store = await fixture();
    const parent = manifest("probe/parent", {
      output: { recordAs: "answer", schema: "./output.json" },
    });
    const child = manifest("probe/child", { trigger: { type: "manual" } });
    const loadRuntime = vi.fn(
      async (runtime: RuntimeManifest): Promise<LoadedRuntime> => ({
        manifest: runtime,
        promptTemplate: "",
        ...(runtime.name === parent.name ? { outputSchema: schema } : {}),
        handler: async (ctx) => {
          if (runtime.name === parent.name)
            await ctx.recursiveCall({
              manualTrigger: { runtimeId: child.name },
            });
          return withPendingProposals(
            { outcome: "success" as const, value: { text: runtime.name } },
            [
              makeProposal(ctx, timestamp, "plugin.data", {
                namespace: "notes",
                key: runtime.name,
                value: "saved",
              }),
            ],
          );
        },
      }),
    );
    const execution = await executeTurn(input, [parent, child], {
      store,
      loadRuntime,
      llm: { generate: vi.fn() },
    });
    expect(execution.commit.results).toHaveLength(2);
    expect(
      execution.commit.results.map((result) => result.pendingProposals?.length),
    ).toEqual([1, 1]);
    expect(JSON.stringify(execution.result)).not.toContain(
      '"pendingProposals"',
    );
    expect(JSON.stringify(await store.listTurnResults("s"))).not.toContain(
      '"pendingProposals"',
    );
    expect(execution.commit.journalMessages?.length).toBeGreaterThan(0);
    expect(await store.listPluginData("s", "probe", "notes")).toEqual([]);
    const loadedCount = loadRuntime.mock.calls.length;
    const outcome = await commitExecution({
      store,
      execution: structuredClone({ ...execution }),
      completion: {
        kind: "turn",
        turnId: "t",
        durationMs: execution.result.durationMs,
      },
    });
    expect(outcome.status).toBe("committed");
    expect(loadRuntime).toHaveBeenCalledTimes(loadedCount);
    expect(await store.listPluginData("s", "probe", "notes")).toHaveLength(2);
    expect((await store.listTurnMessages("s")).length).toBe(
      execution.commit.journalMessages?.length,
    );
    expect((await store.getSession("s"))?.completedPlayerTurns).toBe(1);
    expect(
      (await store.getLatestRuntimeExport("s", parent.name, "answer"))?.value,
    ).toEqual({ text: parent.name });
  });

  it("does not expose failed handler commands as output", async () => {
    const store = await fixture();
    const runtime = manifest("probe/failure");
    const execution = await executeTurn(input, [runtime], {
      store,
      llm: { generate: vi.fn() },
      loadRuntime: async () => ({
        manifest: runtime,
        promptTemplate: "",
        handler: async (ctx) =>
          withPendingProposals(
            { outcome: "failed" as const, error: "refused" },
            [
              makeProposal(ctx, timestamp, "plugin.data", {
                namespace: "notes",
                key: "secret",
                value: "uncommitted",
              }),
            ],
          ),
      }),
    });
    expect(execution.result.runtimeResults[0]).toMatchObject({
      status: "failed",
      output: { outcome: "failed", error: "refused" },
    });
    expect(JSON.stringify(execution.result)).not.toContain("uncommitted");
    expect(execution.commit.results[0]?.pendingProposals).toBeUndefined();
  });

  it("rolls back writes when an export declaration lacks its schema dependency", async () => {
    const store = await fixture();
    const runtime = manifest("probe/export", {
      output: { recordAs: "answer", schema: "./output.json" },
    });
    const execution = await executeTurn(input, [runtime], {
      store,
      llm: { generate: vi.fn() },
      loadRuntime: async () => ({
        manifest: runtime,
        promptTemplate: "",
        handler: async () => ({
          outcome: "success",
          value: { text: "ready" },
          effects: {
            pluginData: [{ namespace: "notes", key: "export", value: true }],
          },
        }),
      }),
    });
    const outcome = await commitExecution({
      store,
      execution,
      completion: { kind: "turn", turnId: "t", durationMs: 0 },
    });
    expect(outcome).toMatchObject({
      status: "failed",
      error: expect.stringContaining("Missing output schema"),
    });
    expect(await store.listPluginData("s", "probe", "notes")).toEqual([]);
    expect(await store.listTurnMessages("s")).toEqual([]);
    expect((await store.getSession("s"))?.completedPlayerTurns).toBe(0);
    const lowLevel = await finalizeExecution({ store, ...execution.commit });
    expect(lowLevel).toMatchObject({
      status: "failed",
      error: expect.stringContaining("without an output schema loader"),
    });
  });
});
