/**
 * A failed guard hook never lets through what it judged. Only a TurnStart
 * failure of a plugin that runs no story can cost less than the whole turn:
 * when a story and some of that plugin's runtimes are scheduled, the plugin
 * sits the turn out and the rest goes on. Every other failure stops the unit
 * it judged — the runtime, the proposal — and the commit rules decide what
 * that costs; a story it held back is refused, not committed empty.
 */
import { describe, expect, it } from "vitest";
import { createMemoryStore } from "@covel/store/memory";
import type { RuntimeManifest, TurnInput } from "@covel/shared";
import type { FunctionHandler } from "@covel/shared/plugin-runtime";
import {
  commitExecution,
  refuseReleasedJobs,
} from "../src/commit/commit-execution.js";
import { executeTurn } from "../src/execution.js";
import { createHookPipeline } from "../src/hooks/pipeline.js";
import { runWithHookScope } from "../src/hooks/hook-scope.js";
import {
  GUARD_FAILURE_SCOPE,
  GUARD_HOOK_EVENTS,
  type HookEvent,
  type HookHandler,
} from "../src/hooks/types.js";

const SESSION = "session";
const HOOK_FAILED = { reason: "hook-failed", skippedBy: "framework:hook" };
const story: RuntimeManifest = {
  pluginId: "teller",
  name: "teller/story",
  description: "Tell the story",
  stage: "narrative",
  runtimeType: "function",
  outputKind: "story",
  trigger: { type: "auto" },
};
const notes: RuntimeManifest = {
  pluginId: "aux",
  name: "aux/notes",
  description: "Keep notes",
  stage: "pre-turn",
  runtimeType: "function",
  outputKind: "system",
  outputContract: "notes@1",
  trigger: { type: "auto" },
};
const log: RuntimeManifest = {
  pluginId: "other",
  name: "other/log",
  description: "Keep a log",
  stage: "post-turn",
  runtimeType: "function",
  outputKind: "system",
  trigger: { type: "auto" },
};
const handlers: Record<string, FunctionHandler> = {
  [story.name]: async () => ({
    outcome: "success",
    value: { narrativeOutput: "The lamp lights the stairs." },
    effects: {
      pluginData: [{ namespace: "story", key: "seen", value: true }],
    },
  }),
  [notes.name]: async () => ({
    outcome: "success",
    value: {},
    effects: { pluginData: [{ namespace: "notes", key: "k", value: 1 }] },
  }),
  [log.name]: async () => ({
    outcome: "success",
    value: {},
    effects: { pluginData: [{ namespace: "log", key: "k", value: 1 }] },
  }),
};

interface Hook {
  readonly pluginId: string;
  readonly event: HookEvent;
  readonly handler: HookHandler;
}

async function play(
  hooks: readonly Hook[],
  options: {
    readonly runtimes?: readonly RuntimeManifest[];
    readonly handlers?: Readonly<Record<string, FunctionHandler>>;
    readonly phase?: "setup" | "playing";
    readonly input?: Partial<TurnInput>;
  } = {},
) {
  const runtimes = options.runtimes ?? [story, notes, log];
  const store = createMemoryStore();
  const now = new Date().toISOString();
  const activePluginIds = new Set([
    ...runtimes.map((runtime) => runtime.pluginId),
    ...hooks.map((hook) => hook.pluginId),
  ]);
  await store.createSession({
    id: SESSION,
    locale: "en-US",
    status: "active",
    phase: options.phase ?? "playing",
    activePlugins: [...activePluginIds],
    setupRuntimes: {},
    seats: [
      { id: "main", controller: "human", role: "player", characters: "auto" },
    ],
    completedPlayerTurns: 0,
    createdAt: now,
    updatedAt: now,
  });
  const faults: string[] = [];
  const hookPipeline = createHookPipeline({
    onHandlerOutcome: (event) => {
      if (event.outcome !== "ok") faults.push(event.pluginId);
    },
  });
  for (const [index, hook] of hooks.entries())
    hookPipeline.register({
      id: `${hook.pluginId}:${hook.event}:${index}`,
      timeoutMs: 50,
      ...hook,
    });
  const runs: string[] = [];
  const allHandlers = { ...handlers, ...options.handlers };
  const execution = await executeTurn(
    {
      sessionId: SESSION,
      turnId: "turn",
      logicalTurnId: "logical-turn",
      playerMessage: "Climb the stairs.",
      origin: "player",
      ...options.input,
    },
    runtimes,
    {
      store,
      hookPipeline,
      hookScope: { activePluginIds },
      loadRuntime: async (manifest) => ({
        manifest,
        promptTemplate: "",
        handler: async (ctx) => {
          runs.push(manifest.name);
          return allHandlers[manifest.name]!(ctx);
        },
      }),
      llm: {
        generate: async () => {
          throw new Error("no model in this test");
        },
      },
    },
  );
  const outcome = await commitExecution({
    enqueueReleasedJobsInTx: refuseReleasedJobs,
    store,
    execution,
    hookPipeline,
    completion: { kind: "turn", turnId: "turn", durationMs: 0 },
  });
  const saved = async (pluginId: string, namespace: string, key: string) =>
    (await store.getPluginData(SESSION, pluginId, namespace, key))?.value;
  return {
    execution,
    outcome,
    faults,
    runs,
    resultOf: (runtimeId: string) =>
      execution.result.runtimeResults.find(
        (result) => result.runtimeId === runtimeId,
      ),
    saved: {
      story: () => saved("teller", "story", "seen"),
      notes: () => saved("aux", "notes", "k"),
      log: () => saved("other", "log", "k"),
    },
    turns: async () =>
      (await store.getSession(SESSION))?.completedPlayerTurns ?? 0,
  };
}

const broken: HookHandler = async () => {
  throw new Error("hook bug");
};
const hangs: HookHandler = () => new Promise(() => {});
const brokenFor =
  (pluginId: string): HookHandler =>
  async (ctx) => {
    if (ctx.pluginId === pluginId) throw new Error("hook bug");
    return { action: "continue" };
  };

describe("a failing TurnStart hook of a plugin without a story runtime", () => {
  it.each([
    ["throws", broken],
    ["times out", hangs],
  ])(
    "%s: its runtimes sit the turn out, and the turn commits",
    async (_label, handler) => {
      const turn = await play([
        { pluginId: "aux", event: "TurnStart", handler },
      ]);
      expect(turn.execution.result.abortReason).toBeUndefined();
      expect(turn.resultOf(notes.name)).toMatchObject({
        status: "skipped",
        output: HOOK_FAILED,
      });
      expect(turn.runs).not.toContain(notes.name);
      expect(turn.resultOf(story.name)?.status).toBe("success");
      expect(turn.resultOf(log.name)?.status).toBe("success");
      expect(turn.outcome.status).toBe("committed");
      expect(await turn.turns()).toBe(1);
      expect(await turn.saved.story()).toBe(true);
      expect(await turn.saved.log()).toBe(1);
      expect(await turn.saved.notes()).toBeUndefined();
      // Recorded against the hook's owner, for the fault latch.
      expect(turn.faults).toEqual(["aux"]);
    },
  );

  it("still ends the turn when it vetoes", async () => {
    const turn = await play([
      {
        pluginId: "aux",
        event: "TurnStart",
        handler: async () => ({ action: "abort", reason: "Not now." }),
      },
    ]);
    expect(turn.execution.result.abortReason).toBe("Not now.");
    expect(turn.execution.result.runtimeResults).toEqual([]);
    expect(turn.outcome.status).toBe("failed");
    expect(await turn.turns()).toBe(0);
  });

  it("ends the turn when the plugin has hooks alone, which may gate input", async () => {
    const turn = await play([
      { pluginId: "gate", event: "TurnStart", handler: broken },
    ]);
    expect(turn.execution.result.abortReason).toBe("hook bug");
    expect(turn.runs).toEqual([]);
    expect(turn.outcome.status).toBe("failed");
    expect(await turn.turns()).toBe(0);
  });

  it("ends the turn when none of the plugin's runtimes is scheduled", async () => {
    const turn = await play(
      [{ pluginId: "aux", event: "TurnStart", handler: broken }],
      {
        runtimes: [story, { ...notes, trigger: { type: "manual" } }, log],
      },
    );
    expect(turn.execution.result.abortReason).toBe("hook bug");
    expect(turn.runs).toEqual([]);
    expect(turn.outcome.status).toBe("failed");
  });

  it("ends the turn when PreSchedule leaves no story scheduled", async () => {
    const turn = await play([
      { pluginId: "aux", event: "TurnStart", handler: broken },
      {
        pluginId: "other",
        event: "PreSchedule",
        handler: async (_ctx, payload) => ({
          action: "continue",
          replace: {
            triggered: (
              payload as { triggered: readonly RuntimeManifest[] }
            ).triggered.filter((runtime) => runtime.outputKind !== "story"),
          },
        }),
      },
    ]);
    expect(turn.execution.result.abortReason).toBe("hook bug");
    expect(turn.runs).toEqual([]);
  });

  it("ends the turn in the setup phase, where no story runs", async () => {
    const init: RuntimeManifest = {
      ...notes,
      name: "aux/init",
      stage: "setup",
      outputContract: undefined,
    };
    const turn = await play(
      [{ pluginId: "aux", event: "TurnStart", handler: broken }],
      {
        phase: "setup",
        runtimes: [story, notes, init],
        handlers: {
          [init.name]: async () => ({ outcome: "success", value: {} }),
        },
      },
    );
    expect(turn.execution.result.abortReason).toBe("hook bug");
    expect(turn.runs).toEqual([]);
    expect(turn.outcome.status).toBe("failed");
  });

  it("ends a manual run aimed at a runtime that is not a story", async () => {
    const turn = await play(
      [{ pluginId: "aux", event: "TurnStart", handler: broken }],
      {
        input: {
          playerMessage: "",
          origin: "manual",
          manualTrigger: { runtimeId: log.name },
        },
      },
    );
    expect(turn.execution.result.abortReason).toBe("hook bug");
    expect(turn.runs).toEqual([]);
  });

  it("refuses the turn when the story needs one of the plugin's runtimes", async () => {
    const turn = await play(
      [{ pluginId: "aux", event: "TurnStart", handler: broken }],
      {
        runtimes: [
          { ...story, needs: [{ capability: "notes@1" }] },
          notes,
          log,
        ],
      },
    );
    expect(turn.resultOf(story.name)).toMatchObject({
      status: "skipped",
      output: { skippedBy: "framework:needs", failedUpstream: notes.name },
    });
    expect(turn.outcome.status).toBe("failed");
    expect(turn.outcome.error).toContain(`because ${notes.name} failed`);
    expect(await turn.turns()).toBe(0);
    expect(await turn.saved.log()).toBeUndefined();
  });
});

describe("a failing PreStateCommit hook", () => {
  it("rejects a proposal of a plugin without a story, which drops alone", async () => {
    const turn = await play([
      { pluginId: "aux", event: "PreStateCommit", handler: brokenFor("aux") },
    ]);
    expect(turn.outcome.status).toBe("committed");
    expect(turn.outcome.failedProposals).toMatchObject([
      { code: "hook-failed", proposal: { source: { pluginId: "aux" } } },
    ]);
    expect(turn.outcome.isolatedRuntimes).toMatchObject([
      { runtimeId: notes.name, cause: "rejected" },
    ]);
    expect(await turn.turns()).toBe(1);
    expect(await turn.saved.story()).toBe(true);
    expect(await turn.saved.log()).toBe(1);
    expect(await turn.saved.notes()).toBeUndefined();
    expect(new Set(turn.faults)).toEqual(new Set(["aux"]));
  });

  it("rejects another plugin's write that crashes it, rather than letting it through", async () => {
    // The subject writes a value the guard does not expect, so the guard
    // throws reading it. Skipping the guard would commit that write.
    const turn = await play(
      [
        {
          pluginId: "aux",
          event: "PreStateCommit",
          handler: async (_ctx, payload) => {
            const { proposal } = payload as {
              proposal: { type: string; payload: { value: unknown } };
            };
            if (proposal.type !== "plugin.data") return { action: "continue" };
            if ((proposal.payload.value as { limit: number }).limit > 3)
              return { action: "abort", reason: "Over the limit." };
            return { action: "continue" };
          },
        },
      ],
      {
        handlers: {
          [story.name]: async () => ({
            outcome: "success",
            value: { narrativeOutput: "The lamp lights the stairs." },
            effects: {
              pluginData: [
                { namespace: "story", key: "seen", value: { limit: 0 } },
              ],
            },
          }),
          [notes.name]: async () => ({
            outcome: "success",
            value: {},
            effects: {
              pluginData: [
                { namespace: "notes", key: "k", value: { limit: 1 } },
              ],
            },
          }),
          [log.name]: async () => ({
            outcome: "success",
            value: {},
            effects: {
              pluginData: [{ namespace: "log", key: "k", value: null }],
            },
          }),
        },
      },
    );
    expect(turn.outcome.status).toBe("committed");
    expect(turn.outcome.failedProposals).toMatchObject([
      { code: "hook-failed", proposal: { source: { pluginId: "other" } } },
    ]);
    expect(turn.outcome.isolatedRuntimes).toMatchObject([
      { runtimeId: log.name, cause: "rejected" },
    ]);
    expect(await turn.saved.log()).toBeUndefined();
    expect(await turn.saved.notes()).toEqual({ limit: 1 });
    expect(await turn.saved.story()).toEqual({ limit: 0 });
    expect(await turn.turns()).toBe(1);
  });

  it("fails the turn when it fails on the story's proposal", async () => {
    const turn = await play([
      {
        pluginId: "aux",
        event: "PreStateCommit",
        handler: brokenFor("teller"),
      },
    ]);
    expect(turn.outcome.status).toBe("failed");
    expect(await turn.turns()).toBe(0);
    expect(await turn.saved.story()).toBeUndefined();
    expect(await turn.saved.log()).toBeUndefined();
  });

  it("still rejects the story's write when it vetoes it", async () => {
    const turn = await play([
      {
        pluginId: "aux",
        event: "PreStateCommit",
        handler: async (ctx) =>
          ctx.pluginId === "teller"
            ? { action: "abort", reason: "No." }
            : { action: "continue" },
      },
    ]);
    expect(turn.outcome.status).toBe("failed");
    expect(await turn.turns()).toBe(0);
    expect(await turn.saved.story()).toBeUndefined();
  });
});

describe("a failing PreRuntime hook", () => {
  it("skips the runtime it failed on, of any plugin, and the rest runs", async () => {
    const turn = await play([
      { pluginId: "aux", event: "PreRuntime", handler: brokenFor("other") },
    ]);
    expect(turn.resultOf(log.name)).toMatchObject({
      status: "skipped",
      output: HOOK_FAILED,
    });
    expect(turn.runs).not.toContain(log.name);
    expect(turn.resultOf(story.name)?.status).toBe("success");
    expect(turn.resultOf(notes.name)?.status).toBe("success");
    expect(turn.outcome.status).toBe("committed");
    expect(await turn.saved.story()).toBe(true);
    expect(await turn.saved.notes()).toBe(1);
    expect(await turn.saved.log()).toBeUndefined();
  });

  it("refuses the turn when it fails on the story", async () => {
    const turn = await play([
      { pluginId: "aux", event: "PreRuntime", handler: brokenFor("teller") },
    ]);
    expect(turn.resultOf(story.name)).toMatchObject({
      status: "skipped",
      output: HOOK_FAILED,
    });
    expect(turn.outcome.status).toBe("failed");
    expect(turn.outcome.error).toContain("because a hook failed");
    expect(await turn.turns()).toBe(0);
  });

  it("still lets a veto skip the story without refusing the turn", async () => {
    const turn = await play([
      {
        pluginId: "aux",
        event: "PreRuntime",
        handler: async (ctx) =>
          ctx.pluginId === "teller"
            ? { action: "abort", reason: "Quiet turn." }
            : { action: "continue" },
      },
    ]);
    expect(turn.resultOf(story.name)).toMatchObject({
      status: "skipped",
      output: { reason: "Quiet turn." },
    });
    expect(turn.outcome.status).toBe("committed");
  });
});

describe("a failing hook of the story plugin itself", () => {
  it("ends the turn at TurnStart, as before", async () => {
    const turn = await play([
      { pluginId: "teller", event: "TurnStart", handler: broken },
    ]);
    expect(turn.execution.result.abortReason).toBe("hook bug");
    expect(turn.outcome.status).toBe("failed");
    expect(await turn.turns()).toBe(0);
  });

  it("rolls the turn back at PreStateCommit, as before", async () => {
    const turn = await play([
      { pluginId: "teller", event: "PreStateCommit", handler: broken },
    ]);
    expect(turn.outcome.status).toBe("failed");
    expect(await turn.turns()).toBe(0);
    expect(await turn.saved.story()).toBeUndefined();
    expect(await turn.saved.log()).toBeUndefined();
  });

  it("skips the runtime it judged at PreRuntime, as before", async () => {
    const turn = await play([
      { pluginId: "teller", event: "PreRuntime", handler: brokenFor("aux") },
    ]);
    expect(turn.resultOf(notes.name)).toMatchObject({
      status: "skipped",
      output: HOOK_FAILED,
    });
    expect(turn.resultOf(story.name)?.status).toBe("success");
  });
});

describe("the per-event rule for a failed guard handler", () => {
  async function failOnce(
    event: HookEvent,
    options: {
      readonly owner?: string;
      readonly confinable?: (pluginId: string) => boolean;
    },
  ) {
    const pipeline = createHookPipeline();
    pipeline.register({
      id: "failing",
      event,
      ...(options.owner ? { pluginId: options.owner } : {}),
      handler: broken,
    });
    return runWithHookScope(
      { activePluginIds: new Set(options.owner ? [options.owner] : []) },
      () =>
        pipeline.run(
          event,
          {
            event,
            sessionId: SESSION,
            turnId: "turn",
            pluginId: "other",
            runtimeId: "other/log",
          },
          {},
          options.confinable ? { confinable: options.confinable } : {},
        ),
    );
  }
  const always = () => true;

  it("covers exactly the guard events", () => {
    expect(new Set(Object.keys(GUARD_FAILURE_SCOPE))).toEqual(
      GUARD_HOOK_EVENTS,
    );
  });

  it.each(Object.keys(GUARD_FAILURE_SCOPE) as HookEvent[])(
    "%s fails closed unless the caller confines the failure",
    async (event) => {
      expect(await failOnce(event, { owner: "aux" })).toMatchObject({
        action: "abort",
        handlerFailed: true,
      });
      expect(
        await failOnce(event, { owner: "aux", confinable: () => false }),
      ).toMatchObject({ action: "abort", handlerFailed: true });
      // A framework hook is never confined.
      expect(await failOnce(event, { confinable: always })).toMatchObject({
        action: "abort",
        handlerFailed: true,
      });
    },
  );

  it.each(
    (Object.keys(GUARD_FAILURE_SCOPE) as HookEvent[]).filter(
      (event) => GUARD_FAILURE_SCOPE[event] === "closed",
    ),
  )("%s fails closed even when the caller offers to confine", async (event) => {
    expect(
      await failOnce(event, { owner: "aux", confinable: always }),
    ).toMatchObject({ action: "abort", handlerFailed: true });
  });

  it("TurnStart goes on without a failure the caller confines, and names it", async () => {
    const result = await failOnce("TurnStart", {
      owner: "aux",
      confinable: (pluginId) => pluginId === "aux",
    });
    expect(result).toMatchObject({
      action: "continue",
      confined: [{ pluginId: "aux", reason: "hook bug" }],
    });
  });
});
