import { describe, expect, it, vi } from "vitest";
import { createMemoryStore } from "@covel/store/memory";
import type { RuntimeManifest } from "@covel/shared";
import type { LoadedRuntime } from "@covel/shared/plugin-runtime";
import {
  commitExecution,
  createHookPipeline,
  executeTurn,
  resumeSuspendedRuntime,
} from "../src/index.js";

const timestamp = "2026-09-29T00:00:00.000Z";
const input = {
  sessionId: "session",
  turnId: "player-turn",
  logicalTurnId: "logical-player-turn",
  playerMessage: "Continue the story",
  origin: "player" as const,
};

async function suspendedFixture(nested = false) {
  const store = createMemoryStore();
  await store.createSession({
    id: input.sessionId,
    locale: "en-US",
    status: "active",
    phase: "playing",
    setupRuntimes: {},
    activePlugins: ["probe"],
    completedPlayerTurns: 0,
    createdAt: timestamp,
    updatedAt: timestamp,
  });
  const child: RuntimeManifest = {
    name: "probe/child",
    pluginId: "probe",
    runtimeType: "function",
    stage: "narrative",
    outputKind: "plugin",
    trigger: { type: nested ? "manual" : "auto" },
  };
  const parent: RuntimeManifest = {
    ...child,
    name: "probe/parent",
    outputKind: "story",
    trigger: { type: "auto" },
  };
  const deps = {
    store,
    llm: { generate: vi.fn() },
    loadRuntime: async (manifest: RuntimeManifest): Promise<LoadedRuntime> => ({
      manifest,
      promptTemplate: "",
      handler: async (context) => {
        if (manifest.name === parent.name) {
          await context.recursiveCall({
            manualTrigger: { runtimeId: child.name },
          });
          return {
            outcome: "success",
            value: { narrativeOutput: "Waiting for an answer." },
          };
        }
        if (context.resumeData === undefined) {
          return {
            outcome: "suspended",
            reason: "Need player confirmation",
            resumeSchema: { type: "object" },
          };
        }
        return {
          outcome: "success",
          value: { content: "The resumed result." },
        };
      },
    }),
  };
  const execution = await executeTurn(
    input,
    nested ? [parent, child] : [child],
    deps,
  );
  const outcome = await commitExecution({
    store,
    execution,
    completion: { kind: "turn", turnId: input.turnId, durationMs: 0 },
  });
  expect(outcome.status).toBe("committed");
  expect((await store.getSession(input.sessionId))?.completedPlayerTurns).toBe(
    0,
  );
  const suspensions = await store.listSuspensions(input.sessionId);
  expect(suspensions).toHaveLength(1);
  return { store, child, deps, execution, suspension: suspensions[0]! };
}

function completion(
  suspension: Awaited<ReturnType<typeof suspendedFixture>>["suspension"],
) {
  return {
    kind: "resume" as const,
    turnId: suspension.turnId,
    suspensionId: suspension.id,
    pluginId: suspension.pluginId,
    runtimeId: suspension.runtimeId,
  };
}

describe("prepared resume host API", () => {
  it("counts a player turn only when its suspended recursive child finally commits", async () => {
    const { store, child, deps, execution, suspension } =
      await suspendedFixture(true);
    expect(execution.commit.results.map((result) => result.status)).toEqual([
      "success",
      "suspended",
    ]);
    expect(suspension.pendingContinuation.executionContext).toMatchObject({
      logicalTurnId: input.logicalTurnId,
      countPolicy: "complete-player-turn",
    });
    const resumed = await resumeSuspendedRuntime(suspension, {}, child, deps);
    expect(resumed.result.status).toBe("success");
    expect(resumed.commit.executionContext.countPolicy).toBe(
      "complete-player-turn",
    );
    expect(
      (await store.getSuspension(suspension.id))?.resolvedAt,
    ).toBeUndefined();
    expect(
      (await store.getSession(input.sessionId))?.completedPlayerTurns,
    ).toBe(0);
    expect(
      (
        await commitExecution({
          store,
          execution: structuredClone(resumed),
          completion: completion(suspension),
        })
      ).status,
    ).toBe("committed");
    expect(
      (await store.getSession(input.sessionId))?.completedPlayerTurns,
    ).toBe(1);
    expect((await store.getSuspension(suspension.id))?.resolvedAt).toEqual(
      expect.any(String),
    );
  });

  it("does not resolve or count a failed non-story resume even if its caller commits it", async () => {
    const { store, child, deps, suspension } = await suspendedFixture();
    const resumed = await resumeSuspendedRuntime(suspension, {}, child, {
      ...deps,
      loadRuntime: async () => ({
        manifest: child,
        promptTemplate: "",
        handler: async () => ({
          outcome: "failed",
          error: "Confirmation failed",
        }),
      }),
    });
    expect(resumed.result.status).toBe("failed");
    const before = await store.listTurnMessages(input.sessionId);
    const outcome = await commitExecution({
      store,
      execution: resumed,
      completion: completion(suspension),
    });
    expect(outcome.status).toBe("failed");
    expect(
      (await store.getSuspension(suspension.id))?.resolvedAt,
    ).toBeUndefined();
    expect(
      (await store.getSession(input.sessionId))?.completedPlayerTurns,
    ).toBe(0);
    expect(await store.listTurnMessages(input.sessionId)).toEqual(before);
  });

  it("establishes its own hook scope and freezes settings without an outer scope", async () => {
    const { child, deps, suspension } = await suspendedFixture();
    const hookPipeline = createHookPipeline();
    const inactive = vi.fn(async () => ({ action: "continue" as const }));
    hookPipeline.register({
      id: "inactive",
      pluginId: "inactive",
      event: "PreRuntime",
      handler: inactive,
    });
    const settings = { probe: { config: { tone: "original" } } };
    const observed: Readonly<Record<string, unknown>>[] = [];
    let readSettings: (() => Readonly<Record<string, unknown>>) | undefined;
    hookPipeline.register({
      id: "active",
      pluginId: "probe",
      event: "PreRuntime",
      handler: async (context) => {
        readSettings = context.getOwnSettings;
        observed.push(context.getOwnSettings!());
        return { action: "continue" };
      },
    });
    const resumed = await resumeSuspendedRuntime(suspension, {}, child, {
      ...deps,
      hookPipeline,
      hookScope: { activePluginIds: new Set(["probe"]), settings },
    });
    expect(resumed.result.status).toBe("success");
    expect(inactive).not.toHaveBeenCalled();
    expect(observed).toEqual([{ config: { tone: "original" } }]);
    expect(Object.isFrozen(observed[0])).toBe(true);
    expect(Object.isFrozen(observed[0]!.config)).toBe(true);
    expect(Object.isFrozen(settings.probe.config)).toBe(false);
    settings.probe.config.tone = "later";
    expect(readSettings?.()).toEqual({ config: { tone: "original" } });
    expect(resumed.commit.hookSettings?.probe).toEqual({
      config: { tone: "original" },
    });
  });

  it("records the resumed function output once in the plan and committed journal", async () => {
    const { store, child, deps, suspension } = await suspendedFixture();
    const resumed = await resumeSuspendedRuntime(suspension, {}, child, deps);
    expect(resumed.result.status).toBe("success");
    const messages = resumed.commit.journalMessages?.filter(
      (message) => message.sourceRuntimeId === child.name,
    );
    expect(messages).toHaveLength(1);
    expect(messages![0]!.content).toBe("The resumed result.");
    expect(
      (
        await commitExecution({
          store,
          execution: resumed,
          completion: completion(suspension),
        })
      ).status,
    ).toBe("committed");
    const stored = (await store.listTurnMessages(input.sessionId)).filter(
      (message) => message.sourceRuntimeId === child.name,
    );
    expect(stored).toHaveLength(1);
    expect(stored[0]!.content).toBe("The resumed result.");
  });
});
