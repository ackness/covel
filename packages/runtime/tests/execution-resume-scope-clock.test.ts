/**
 * Regression tests for `packages/runtime/src/execution.ts`:
 *  1. `resumeSuspendedRuntime` fallback `hookScope` derives `activePluginIds`
 *     and `settings` from `options.activeRuntimes`, not `[manifest]` alone.
 *  2. `executeTurn` attaches `sessionClock` whenever `turn.setupCompletion` is
 *     present (even for non-player origins like `"continuation"`), persisting
 *     late-setup completion atomically without advancing `completedPlayerTurns`.
 */

import { describe, expect, it, vi } from "vitest";
import { createMemoryStore } from "@covel/store/memory";
import type { HandlerResult, RuntimeManifest } from "@covel/shared";
import type { LoadedRuntime } from "@covel/shared/plugin-runtime";
import {
  commitExecution,
  createHookPipeline,
  executeTurn,
  refuseReleasedJobs,
  resumeSuspendedRuntime,
} from "../src/index.js";

const TIMESTAMP = "2026-09-29T00:00:00.000Z";

async function createPlayingSession(
  store: ReturnType<typeof createMemoryStore>,
  sessionId: string,
  activePlugins: readonly string[],
  completedPlayerTurns = 2,
) {
  await store.createSession({
    id: sessionId,
    locale: "en-US",
    status: "active",
    phase: "playing",
    setupRuntimes: {},
    seats: [
      { id: "main", controller: "human", role: "player", characters: "auto" },
    ],
    activePlugins: [...activePlugins],
    completedPlayerTurns,
    createdAt: TIMESTAMP,
    updatedAt: TIMESTAMP,
  });
}

describe("resumeSuspendedRuntime fallback hookScope", () => {
  it("builds activePluginIds and settings from options.activeRuntimes when deps.hookScope is omitted", async () => {
    const store = createMemoryStore();
    await createPlayingSession(store, "sess-resume-scope", [
      "probe",
      "observer",
    ]);

    const child: RuntimeManifest = {
      name: "probe/child",
      pluginId: "probe",
      description: "resumable child",
      runtimeType: "function",
      stage: "narrative",
      outputKind: "system",
      trigger: { type: "auto" },
      userSettings: [
        { key: "level", type: "number", default: 1, label: "Level" },
      ],
    };
    const observer: RuntimeManifest = {
      name: "observer/audit",
      pluginId: "observer",
      description: "observer plugin",
      runtimeType: "function",
      stage: "audit",
      outputKind: "system",
      trigger: { type: "auto" },
      userSettings: [
        { key: "mode", type: "select", default: "relaxed", label: "Mode" },
        {
          key: "fallback",
          type: "select",
          default: "default-val",
          label: "Fallback",
        },
      ],
    };

    const baseDeps = {
      store,
      llm: { generate: vi.fn() },
      loadRuntime: async (
        manifest: RuntimeManifest,
      ): Promise<LoadedRuntime> => ({
        manifest,
        promptTemplate: "",
        handler: async (context): Promise<HandlerResult> => {
          if (
            manifest.name === child.name &&
            context.resumeData === undefined
          ) {
            return {
              outcome: "suspended",
              reason: "Need player confirmation",
              resumeSchema: { type: "object" },
            };
          }
          return {
            outcome: "success",
            value: { content: "Resumed" },
            effects: {
              pluginData: [{ namespace: "notes", key: "done", value: true }],
            },
          };
        },
      }),
    };

    // Pause `probe/child` on a turn.
    const suspendedTurn = await executeTurn(
      {
        sessionId: "sess-resume-scope",
        turnId: "turn-1",
        logicalTurnId: "logical-1",
        playerMessage: "Go",
        origin: "player",
      },
      [child],
      baseDeps,
    );
    const suspendCommit = await commitExecution({
      enqueueReleasedJobsInTx: refuseReleasedJobs,
      store,
      execution: suspendedTurn,
      completion: { kind: "turn", turnId: "turn-1", durationMs: 0 },
    });
    expect(suspendCommit.status).toBe("committed");
    const [suspension] = await store.listSuspensions("sess-resume-scope");
    expect(suspension).toBeDefined();

    // Register hooks owned by `observer` (not `probe`).
    const hookPipeline = createHookPipeline();
    const postRuntimeSettings: Array<Readonly<Record<string, unknown>>> = [];
    const preCommitSettings: Array<Readonly<Record<string, unknown>>> = [];
    hookPipeline.register({
      id: "observer:PostRuntime",
      pluginId: "observer",
      event: "PostRuntime",
      handler: async (ctx) => {
        postRuntimeSettings.push(ctx.getOwnSettings!());
        return { action: "continue" };
      },
    });
    hookPipeline.register({
      id: "observer:PreStateCommit",
      pluginId: "observer",
      event: "PreStateCommit",
      handler: async (ctx) => {
        preCommitSettings.push(ctx.getOwnSettings!());
        return { action: "continue" };
      },
    });

    // Resume WITHOUT an explicit deps.hookScope, passing activeRuntimes + userSettings.
    const resumed = await resumeSuspendedRuntime(
      suspension!,
      { ok: true },
      child,
      { ...baseDeps, hookPipeline },
      {
        activeRuntimes: [child, observer],
        userSettings: {
          probe: { level: 5 },
          observer: { mode: "strict" },
        },
      },
    );

    expect(resumed.result.status).toBe("success");
    expect(postRuntimeSettings).toEqual([
      { mode: "strict", fallback: "default-val" },
    ]);
    expect(resumed.commit.activePluginIds).toEqual(
      new Set(["probe", "observer"]),
    );
    expect(resumed.commit.hookSettings).toEqual({
      probe: { level: 5 },
      observer: { mode: "strict", fallback: "default-val" },
    });

    // Commit phase also receives observer's hookScope from the commit plan.
    const commitOutcome = await commitExecution({
      enqueueReleasedJobsInTx: refuseReleasedJobs,
      store,
      execution: resumed,
      hookPipeline,
      completion: {
        kind: "resume",
        turnId: suspension!.turnId,
        suspensionId: suspension!.id,
        pluginId: suspension!.pluginId,
        runtimeId: suspension!.runtimeId,
      },
    });
    expect(commitOutcome.status).toBe("committed");
    expect(preCommitSettings).toEqual([
      { mode: "strict", fallback: "default-val" },
    ]);
  });
});

describe("executeTurn non-player late-setup sessionClock", () => {
  const lateSetup: RuntimeManifest = {
    name: "addon/setup",
    pluginId: "addon",
    version: "1.0.0",
    description: "late setup runtime",
    runtimeType: "function",
    stage: "setup",
    outputKind: "system",
    trigger: { type: "auto" },
  };
  const mainRuntime: RuntimeManifest = {
    name: "addon/main",
    pluginId: "addon",
    version: "1.0.0",
    description: "main runtime",
    runtimeType: "function",
    stage: "post-turn",
    outputKind: "system",
    trigger: { type: "auto" },
  };

  it("persists late-setup completion for a non-player continuation without advancing completedPlayerTurns", async () => {
    const store = createMemoryStore();
    await createPlayingSession(store, "sess-cont-setup", ["addon"], 2);

    const execution = await executeTurn(
      {
        sessionId: "sess-cont-setup",
        turnId: "turn-cont-1",
        logicalTurnId: "logical-cont-1",
        playerMessage: "",
        origin: "continuation",
      },
      [lateSetup, mainRuntime],
      {
        store,
        llm: { generate: vi.fn() },
        loadRuntime: async (manifest): Promise<LoadedRuntime> => ({
          manifest,
          promptTemplate: "",
          handler: async (): Promise<HandlerResult> =>
            manifest.name === lateSetup.name
              ? {
                  outcome: "success",
                  value: { ready: true },
                  completion: "done",
                }
              : { outcome: "success", value: { ok: true } },
        }),
      },
    );

    expect(
      execution.result.setupCompletion?.newlyDone["addon/setup"],
    ).toMatchObject({
      state: "done",
      resolution: "completed",
    });
    expect(
      execution.commit.sessionClock?.setupCompletion?.newlyDone["addon/setup"],
    ).toMatchObject({
      state: "done",
      resolution: "completed",
    });

    const outcome = await commitExecution({
      enqueueReleasedJobsInTx: refuseReleasedJobs,
      store,
      execution,
      completion: { kind: "turn", turnId: "turn-cont-1", durationMs: 0 },
    });
    expect(outcome.status).toBe("committed");

    const session = await store.getSession("sess-cont-setup");
    expect(session?.setupRuntimes["addon/setup"]).toMatchObject({
      state: "done",
      resolution: "completed",
      pluginVersion: "1.0.0",
    });
    // Non-player execution must NOT advance completedPlayerTurns.
    expect(session?.completedPlayerTurns).toBe(2);
    expect(
      await store.getLogicalTurnCompletion("sess-cont-setup", "logical-cont-1"),
    ).toBeNull();
  });

  it("omits sessionClock for a non-player execution with no setup completion", async () => {
    const store = createMemoryStore();
    await createPlayingSession(store, "sess-cont-no-setup", ["addon"], 2);

    const execution = await executeTurn(
      {
        sessionId: "sess-cont-no-setup",
        turnId: "turn-cont-2",
        playerMessage: "",
        origin: "continuation",
      },
      [mainRuntime],
      {
        store,
        llm: { generate: vi.fn() },
        loadRuntime: async (manifest): Promise<LoadedRuntime> => ({
          manifest,
          promptTemplate: "",
          handler: async () => ({ outcome: "success", value: { ok: true } }),
        }),
      },
    );

    expect(execution.commit.sessionClock).toBeUndefined();
  });
});
