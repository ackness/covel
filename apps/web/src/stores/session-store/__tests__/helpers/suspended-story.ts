import { vi } from "vitest";
import { z } from "zod";
import { createMemoryStore } from "@covel/store/memory";
import type { HandlerResult, RuntimeManifest, Session } from "@covel/shared";
import type { LoadedRuntime } from "@covel/shared/plugin-runtime";
import { createEventBus } from "../../../../../../../packages/events/src/index.js";
import {
  buildSessionSnapshot,
  commitExecution,
  executeTurn,
  PluginServiceRegistry,
} from "../../../../../../../packages/runtime/src/index.js";

/** Real commit and subscription events, without HTTP or model requests. */
export async function suspendedStory(manual: boolean) {
  const store = createMemoryStore();
  const eventBus = createEventBus();
  const timestamp = "2026-10-31T00:00:00.000Z";
  const session = {
    id: "session",
    worldId: "",
    incarnation: "incarnation",
    locale: "en-US",
    status: "active",
    phase: "playing",
    setupRuntimes: {},
    seats: [
      { id: "main", controller: "human", role: "player", characters: "auto" },
    ],
    activePlugins: ["teller", "provider"],
    completedPlayerTurns: 0,
    autoAdvanceLimit: 3,
    createdAt: timestamp,
    updatedAt: timestamp,
  } satisfies Session;
  await store.createSession(session);
  const services = new PluginServiceRegistry({
    list: async () => ["teller", "provider"],
    ensure: async () => {},
  });
  services.register("provider", {
    name: "change",
    contract: "change@1",
    access: "write",
    input: z.object({}),
    output: z.object({}),
    handler: async (_input, ctx) => {
      await ctx.pluginData.set("values", "change", { applied: true });
      return {};
    },
  });
  const story: RuntimeManifest = {
    name: "teller/story",
    pluginId: "teller",
    description: "Story",
    runtimeType: "function",
    stage: "narrative",
    outputKind: "story",
    trigger: { type: manual ? "manual" : "auto" },
  };
  const child: RuntimeManifest = {
    ...story,
    name: "teller/confirmation",
    outputKind: "system",
  };
  const commit = async () => {
    const execution = await executeTurn(
      {
        sessionId: session.id,
        turnId: "turn",
        playerMessage: "Continue",
        origin: manual ? "manual" : "player",
        ...(manual ? { manualTrigger: { runtimeId: story.name } } : {}),
      },
      [story, child],
      {
        store,
        eventBus,
        services,
        llm: { generate: vi.fn() },
        loadRuntime: async (manifest): Promise<LoadedRuntime> => ({
          manifest,
          promptTemplate: "",
          handler: async (ctx): Promise<HandlerResult> => {
            if (manifest.name === child.name)
              return {
                outcome: "suspended",
                reason: "Confirm the next step",
                resumeSchema: { type: "object" },
              };
            if (!ctx.services) throw new Error("Expected service access");
            await ctx.services.call({
              pluginId: "provider",
              name: "change",
              contract: "change@1",
              input: {},
            });
            if (manual)
              await ctx.recursiveCall({
                manualTrigger: { runtimeId: child.name },
              });
            return {
              outcome: "success",
              value: { narrativeOutput: "The guide waits for your answer." },
            };
          },
        }),
      },
    );
    return commitExecution({
      store,
      eventBus,
      execution,
      completion: { kind: "turn", turnId: "turn", durationMs: 0 },
      proposalGuard: (proposal) =>
        proposal.source.pluginId === "provider" ? "Rejected change" : undefined,
    });
  };
  return {
    store,
    eventBus,
    session,
    commit,
    view: () => buildSessionSnapshot(store, session.id),
    close: async () => {
      await eventBus.close();
      await store.close();
    },
  };
}
