/**
 * Every execution entry point opens its own session hook scope.
 *
 * This file deliberately has no ambient scope: hooks fire only because
 * executeTurn, resumeSuspendedRuntime and commitExecution (finalize) each
 * establish one from the host's `hookScope`. A hook-only plugin's handlers
 * see its captured settings and the session locale; an inactive plugin's
 * handlers never run.
 */

import { expect, it } from "vitest";
import type { RuntimeManifest } from "@covel/shared";
import { createMemoryStore } from "@covel/store/memory";
import {
  commitExecution,
  createHookPipeline,
  executeTurn,
  refuseReleasedJobs,
  resumeSuspendedRuntime,
  type HookScope,
} from "../src/index.js";
import type { ExecutionDeps } from "../src/execution.js";
import {
  currentOwnSettings,
  MissingHookScopeError,
} from "../src/hooks/hook-scope.js";
import type { HookEvent } from "../src/hooks/types.js";

const SESSION = "session";
const timestamp = "2026-11-09T00:00:00.000Z";

it("sets the hook scope at execution, resume and commit without an ambient one", async () => {
  // No scope leaks into this test from the file or the runner.
  expect(() => currentOwnSettings("guard")).toThrow(MissingHookScopeError);

  const store = createMemoryStore();
  await store.createSession({
    id: SESSION,
    locale: "en-US",
    status: "active",
    phase: "playing",
    setupRuntimes: {},
    seats: [
      { id: "main", controller: "human", role: "player", characters: "auto" },
    ],
    activePlugins: ["probe", "guard"],
    completedPlayerTurns: 0,
    createdAt: timestamp,
    updatedAt: timestamp,
  });
  const runtime: RuntimeManifest = {
    description: "test",
    name: "probe/asker",
    pluginId: "probe",
    runtimeType: "function",
    stage: "post-turn",
    outputKind: "system",
    trigger: { type: "auto" },
  };
  // `guard` has hooks but no runtime: only the host's scope can include it.
  const hookScope: HookScope = {
    activePluginIds: new Set(["probe", "guard"]),
    settings: { guard: Object.freeze({ mode: "strict" }) },
    locale: "en-US",
  };
  const hookPipeline = createHookPipeline();
  const seen: Array<{
    event: HookEvent;
    pluginId: string;
    settings: unknown;
    locale: string | undefined;
  }> = [];
  for (const pluginId of ["guard", "inactive"])
    for (const event of [
      "PreRuntime",
      "PostRuntime",
      "PreStateCommit",
    ] as const)
      hookPipeline.register({
        id: `${pluginId}:${event}`,
        event,
        pluginId,
        handler: async (ctx) => {
          seen.push({
            event,
            pluginId,
            settings: ctx.getOwnSettings?.(),
            locale: ctx.locale,
          });
          return { action: "continue" };
        },
      });

  let leg = 0;
  const deps: ExecutionDeps = {
    store,
    hookPipeline,
    hookScope,
    llm: {
      generate: async () => {
        throw new Error("no model call expected");
      },
    },
    loadRuntime: async (manifest) => ({
      manifest,
      promptTemplate: "",
      handler: async () =>
        leg === 0
          ? {
              outcome: "suspended",
              reason: "question",
              resumeSchema: { type: "object" },
            }
          : {
              outcome: "success",
              value: { answered: true },
              effects: {
                pluginData: [
                  { namespace: "notes", key: "answer", value: "yes" },
                ],
              },
            },
    }),
  };

  // Player turn: the runtime suspends.
  const execution = await executeTurn(
    {
      sessionId: SESSION,
      turnId: "player-turn",
      playerMessage: "Ask",
      origin: "player",
    },
    [runtime],
    deps,
  );
  expect(execution.result.runtimeResults[0]?.status).toBe("suspended");
  const committed = await commitExecution({
    enqueueReleasedJobsInTx: refuseReleasedJobs,
    store,
    hookPipeline,
    execution,
    completion: { kind: "turn", turnId: "player-turn", durationMs: 0 },
  });
  expect(committed.status).toBe("committed");

  // Resume: the runtime finishes and writes, so finalize fires commit hooks.
  leg = 1;
  const [suspension] = await store.listSuspensions(SESSION);
  const resumed = await resumeSuspendedRuntime(suspension!, {}, runtime, deps);
  expect(resumed.result.status).toBe("success");
  const outcome = await commitExecution({
    enqueueReleasedJobsInTx: refuseReleasedJobs,
    store,
    hookPipeline,
    execution: resumed,
    completion: {
      kind: "resume",
      turnId: suspension!.turnId,
      suspensionId: suspension!.id,
      pluginId: suspension!.pluginId,
      runtimeId: suspension!.runtimeId,
    },
  });
  expect(outcome.status).toBe("committed");

  const expected = { settings: { mode: "strict" }, locale: "en-US" };
  expect(seen).toEqual([
    { event: "PreRuntime", pluginId: "guard", ...expected },
    { event: "PostRuntime", pluginId: "guard", ...expected },
    { event: "PreStateCommit", pluginId: "guard", ...expected },
  ]);
  expect(
    (await store.getPluginData(SESSION, "probe", "notes", "answer"))?.value,
  ).toBe("yes");
  // The entry points' scopes ended with them.
  expect(() => currentOwnSettings("guard")).toThrow(MissingHookScopeError);
});
