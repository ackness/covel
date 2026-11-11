import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { createMemoryStore } from "@covel/store/memory";
import type { Proposal, RuntimeManifest, TurnInput } from "@covel/shared";
import type { HandlerResult } from "@covel/plugin-handlers-utils";
import type { LoadedRuntime } from "@covel/shared/plugin-runtime";
import {
  executeTurn,
  commitExecution,
  refuseReleasedJobs,
  PluginServiceRegistry,
} from "../src/index.js";
import { createHookPipeline } from "../src/hooks/pipeline.js";

beforeEach(() => {
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

function manifest(
  name: string,
  extra: Partial<RuntimeManifest> = {},
): RuntimeManifest {
  return {
    name,
    pluginId: name,
    description: name,
    runtimeType: "function",
    stage: "post-turn",
    trigger: { type: "auto" },
    outputKind: "system",
    ...extra,
  };
}

async function fixture(options: {
  readonly reject: "a" | "b";
  readonly manual?: boolean;
  readonly suspended?: boolean;
  readonly relay?: boolean;
}) {
  const store = createMemoryStore();
  const now = new Date().toISOString();
  await store.createSession({
    id: "s",
    locale: "en-US",
    status: "active",
    phase: "playing",
    completedPlayerTurns: 0,
    setupRuntimes: {},
    seats: [
      { id: "main", controller: "human", role: "player", characters: "auto" },
    ],
    activePlugins: ["story", "a", "b", "consumer", "next"],
    createdAt: now,
    updatedAt: now,
  });
  const runtimes = [
    manifest("story", { stage: "narrative", outputKind: "story" }),
    manifest("a"),
    manifest("b"),
    manifest("consumer", { trigger: { type: "event", topic: "changed" } }),
    ...(options.relay
      ? [manifest("next", { trigger: { type: "event", topic: "relayed" } })]
      : []),
  ];
  const input: TurnInput = {
    sessionId: "s",
    turnId: "t",
    playerMessage: "Continue",
    origin: options.manual ? "manual" : "player",
    ...(options.manual
      ? { manualTrigger: { runtimeIds: ["story", "a", "consumer"] } }
      : {}),
  };
  const execution = await executeTurn(input, runtimes, {
    store,
    llm: { generate: vi.fn() },
    loadRuntime: async (runtime): Promise<LoadedRuntime> => ({
      manifest: runtime,
      promptTemplate: "",
      handler: async (ctx): Promise<HandlerResult> => {
        if (runtime.name === "story")
          return {
            outcome: "success",
            value: { narrativeOutput: "A complete scene." },
          };
        if (runtime.name === "a" || runtime.name === "b")
          return {
            outcome: "success",
            value: {},
            effects: {
              events: [{ topic: "changed", data: { selected: runtime.name } }],
              pluginData: [
                { namespace: "state", key: "own", value: runtime.name },
              ],
            },
          };
        if (runtime.name === "consumer" && options.suspended)
          return {
            outcome: "suspended",
            reason: "Wait for the player's answer",
            resumeSchema: {},
          };
        const selection = ctx.triggerEvent?.data.selected;
        const selected = typeof selection === "string" ? selection : "manual";
        await ctx.pluginData!.set("state", "selected", selected);
        return {
          outcome: "success",
          value: {},
          ...(runtime.name === "consumer" && options.relay
            ? {
                effects: { events: [{ topic: "relayed", data: { selected } }] },
              }
            : {}),
        };
      },
    }),
  });
  const hooks = createHookPipeline();
  hooks.register({
    id: "reject-selected-producer",
    event: "PreStateCommit",
    handler: async (_ctx, payload) => {
      const { proposal } = payload as { proposal: Proposal };
      return proposal.source.pluginId === options.reject
        ? { action: "abort", reason: "Synthetic veto" }
        : { action: "continue" };
    },
  });
  const outcome = await commitExecution({
    // The invocation graph must survive the public API's copied plan.
    execution: structuredClone(execution),
    store,
    hookPipeline: hooks,
    enqueueReleasedJobsInTx: refuseReleasedJobs,
    completion: {
      kind: "turn",
      turnId: "t",
      durationMs: execution.result.durationMs,
    },
  });
  return { store, execution, outcome };
}

describe("event payload commit provenance", () => {
  it.each(["a", "b"] as const)(
    "follows the selected producer when %s is rejected",
    async (reject) => {
      const { store, execution, outcome } = await fixture({ reject });
      const producer = execution.result.runtimeResults.find(
        (result) => result.runtimeId === "a",
      )!;
      const consumer = execution.result.runtimeResults.find(
        (result) => result.runtimeId === "consumer",
      )!;
      expect(execution.commit.eventDependencies?.runs[consumer.runId]).toBe(
        producer.runId,
      );
      expect(outcome.status).toBe("committed");
      expect(
        (await store.getPluginData("s", "consumer", "state", "selected"))
          ?.value,
      ).toBe(reject === "a" ? undefined : "a");
      expect(
        outcome.isolatedRuntimes?.map((result) => result.runtimeId),
      ).toEqual(reject === "a" ? ["a", "consumer"] : ["b"]);
      await store.close();
    },
  );

  it("keeps an explicitly selected event runtime independent of events emitted in that batch", async () => {
    const { store, execution, outcome } = await fixture({
      reject: "a",
      manual: true,
    });
    expect(execution.commit.eventDependencies).toEqual({
      runs: {},
      followers: [],
    });
    expect(outcome.status).toBe("committed");
    expect(
      (await store.getPluginData("s", "consumer", "state", "selected"))?.value,
    ).toBe("manual");
    expect(outcome.isolatedRuntimes?.map((result) => result.runtimeId)).toEqual(
      ["a"],
    );
    await store.close();
  });

  it("drops a suspended follower with no writes when its selected producer was rejected", async () => {
    const { store, outcome } = await fixture({ reject: "a", suspended: true });
    expect(outcome.status).toBe("committed");
    expect(outcome.isolatedRuntimes?.map((result) => result.runtimeId)).toEqual(
      ["a", "consumer"],
    );
    expect(await store.listSuspensions("s")).toEqual([]);
    await store.close();
  });

  it("cascades through each selected producer at later event depths", async () => {
    const { store, execution, outcome } = await fixture({
      reject: "a",
      relay: true,
    });
    const consumer = execution.result.runtimeResults.find(
      (result) => result.runtimeId === "consumer",
    )!;
    const next = execution.result.runtimeResults.find(
      (result) => result.runtimeId === "next",
    )!;
    expect(execution.commit.eventDependencies?.runs[next.runId]).toBe(
      consumer.runId,
    );
    expect(outcome.status).toBe("committed");
    expect(outcome.isolatedRuntimes?.map((result) => result.runtimeId)).toEqual(
      ["a", "consumer", "next"],
    );
    expect(
      await store.getPluginData("s", "next", "state", "selected"),
    ).toBeNull();
    await store.close();
  });
});

it("drops operation-only nested work under a skipped event guard with its producer", async () => {
  const store = createMemoryStore();
  const now = new Date().toISOString();
  const plugins = ["story", "up", "probe", "bank"];
  await store.createSession({
    id: "s",
    locale: "en-US",
    status: "active",
    phase: "playing",
    completedPlayerTurns: 0,
    setupRuntimes: {},
    activePlugins: plugins,
    seats: [
      { id: "main", controller: "human", role: "player", characters: "auto" },
    ],
    createdAt: now,
    updatedAt: now,
  });
  const story = manifest("story", { stage: "narrative", outputKind: "story" });
  const up = manifest("up");
  const consumer = manifest("probe/consumer", {
    pluginId: "probe",
    runtimeType: "agent",
    trigger: { type: "event", topic: "probe.changed" },
  });
  const child = manifest("probe/child", {
    pluginId: "probe",
    trigger: { type: "manual" },
  });
  const services = new PluginServiceRegistry({
    list: async () => plugins,
    ensure: async () => {},
  });
  services.register("bank", {
    name: "write",
    contract: "bank.write@1",
    access: "write",
    input: z.object({}),
    output: z.unknown(),
    handler: async (_input, ctx) => {
      await ctx.pluginData.set("state", "effect", { landed: true });
      return {};
    },
  });
  const execution = await executeTurn(
    {
      sessionId: "s",
      turnId: "t",
      playerMessage: "Continue",
      origin: "player",
    },
    [story, up, consumer, child],
    {
      store,
      services,
      hookScope: { activePluginIds: new Set(plugins) },
      llm: { generate: vi.fn() },
      loadRuntime: async (runtime): Promise<LoadedRuntime> => ({
        manifest: runtime,
        promptTemplate: "",
        ...(runtime.name === consumer.name
          ? {
              guard: async (ctx) => {
                await ctx.recursiveCall({
                  manualTrigger: { runtimeId: child.name },
                });
                return { skip: true };
              },
            }
          : {
              handler: async (ctx): Promise<HandlerResult> => {
                if (runtime.name === story.name)
                  return {
                    outcome: "success",
                    value: { narrativeOutput: "A complete scene." },
                  };
                if (runtime.name === up.name)
                  return {
                    outcome: "success",
                    value: {},
                    effects: {
                      events: [{ topic: "probe.changed", data: {} }],
                      pluginData: [{ namespace: "state", key: "up", value: 1 }],
                    },
                  };
                await ctx.services!.call({
                  pluginId: "bank",
                  name: "write",
                  contract: "bank.write@1",
                  input: {},
                });
                return { outcome: "success", value: {} };
              },
            }),
      }),
    },
  );
  const nested = execution.commit.results.find(
    (result) => result.runtimeId === child.name,
  )!;
  expect(nested.pendingProposals ?? []).toEqual([]);
  expect(nested.operations).toHaveLength(1);
  const outcome = await commitExecution({
    execution,
    store,
    enqueueReleasedJobsInTx: refuseReleasedJobs,
    completion: { kind: "turn", turnId: "t", durationMs: 0 },
    proposalGuard: (proposal) =>
      proposal.source.pluginId === "up" ? "Reject producer" : undefined,
  });
  expect(outcome.status).toBe("committed");
  expect(outcome.isolatedRuntimes?.map((result) => result.runtimeId)).toEqual([
    up.name,
    child.name,
    consumer.name,
  ]);
  expect(await store.getPluginData("s", "bank", "state", "effect")).toBeNull();
  await store.close();
});
