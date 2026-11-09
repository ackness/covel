/**
 * A failing hook of an auxiliary plugin — one that runs no story runtime —
 * costs only that plugin's own unit when the execution has a story. Hooks
 * that decide (a veto) and the story plugin's own hooks keep their effect,
 * and the security gates stay fail-closed for everyone.
 */
import { describe, expect, it } from "vitest";
import { createMemoryStore } from "@covel/store/memory";
import type { RuntimeManifest } from "@covel/shared";
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
  stage: "post-turn",
  runtimeType: "function",
  outputKind: "system",
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
const runtimes = [story, notes, log];
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

async function play(
  hooks: readonly {
    readonly pluginId: string;
    readonly event: HookEvent;
    readonly handler: HookHandler;
  }[],
) {
  const store = createMemoryStore();
  const now = new Date().toISOString();
  await store.createSession({
    id: SESSION,
    locale: "en-US",
    status: "active",
    phase: "playing",
    activePlugins: runtimes.map((runtime) => runtime.pluginId),
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
  const execution = await executeTurn(
    {
      sessionId: SESSION,
      turnId: "turn",
      logicalTurnId: "logical-turn",
      playerMessage: "Climb the stairs.",
      origin: "player",
    },
    runtimes,
    {
      store,
      hookPipeline,
      hookScope: {
        activePluginIds: new Set(runtimes.map((runtime) => runtime.pluginId)),
      },
      loadRuntime: async (manifest) => ({
        manifest,
        promptTemplate: "",
        handler: handlers[manifest.name],
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
    store,
    execution,
    outcome,
    faults,
    statusOf: (runtimeId: string) =>
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

describe("an auxiliary plugin's failing TurnStart hook", () => {
  it.each([
    ["throws", broken],
    ["times out", hangs],
  ])(
    "%s: its own runtimes sit the turn out, and the turn commits",
    async (_label, handler) => {
      const turn = await play([
        { pluginId: "aux", event: "TurnStart", handler },
      ]);
      expect(turn.execution.result.abortReason).toBeUndefined();
      expect(turn.statusOf(notes.name)).toMatchObject({
        status: "skipped",
        output: { reason: "hook-failed" },
      });
      expect(turn.statusOf(story.name)?.status).toBe("success");
      expect(turn.statusOf(log.name)?.status).toBe("success");
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
});

describe("an auxiliary plugin's failing PreStateCommit hook", () => {
  it("drops its own proposals and lets the rest commit", async () => {
    const turn = await play([
      { pluginId: "aux", event: "PreStateCommit", handler: broken },
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
    expect(turn.faults.length).toBeGreaterThan(0);
    expect(new Set(turn.faults)).toEqual(new Set(["aux"]));
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

describe("an auxiliary plugin's failing PreRuntime hook", () => {
  it("skips its own runtime and lets the story and the others run", async () => {
    const turn = await play([
      { pluginId: "aux", event: "PreRuntime", handler: broken },
    ]);
    expect(turn.statusOf(notes.name)?.status).toBe("skipped");
    expect(turn.statusOf(story.name)?.status).toBe("success");
    expect(turn.statusOf(log.name)?.status).toBe("success");
    expect(turn.outcome.status).toBe("committed");
    expect(await turn.saved.story()).toBe(true);
    expect(await turn.saved.log()).toBe(1);
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
      {
        pluginId: "teller",
        event: "PreRuntime",
        handler: async (ctx) => {
          if (ctx.pluginId === "aux") throw new Error("hook bug");
          return { action: "continue" };
        },
      },
    ]);
    expect(turn.statusOf(notes.name)?.status).toBe("skipped");
    expect(turn.statusOf(story.name)?.status).toBe("success");
  });
});

describe("the per-event rule for a failed guard handler", () => {
  const ctx = (event: HookEvent, pluginId?: string) => ({
    event,
    sessionId: SESSION,
    turnId: "turn",
    ...(pluginId ? { pluginId, runtimeId: `${pluginId}/run` } : {}),
  });
  async function failOnce(
    event: HookEvent,
    options: {
      readonly owner?: string;
      readonly subject?: string;
      readonly storyPluginIds?: ReadonlySet<string>;
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
      {
        activePluginIds: new Set(["teller", "aux", "other"]),
        ...(options.storyPluginIds
          ? { storyPluginIds: options.storyPluginIds }
          : {}),
      },
      () => pipeline.run(event, ctx(event, options.subject), {}),
    );
  }
  const withStory = new Set(["teller"]);

  it("covers exactly the guard events", () => {
    expect(new Set(Object.keys(GUARD_FAILURE_SCOPE))).toEqual(
      GUARD_HOOK_EVENTS,
    );
  });

  it.each(["PreToolUse", "ReviewAgentOutput", "PreCompaction"] as const)(
    "%s fails closed for an auxiliary plugin, whatever it judged",
    async (event) => {
      const result = await failOnce(event, {
        owner: "aux",
        subject: "teller",
        storyPluginIds: withStory,
      });
      expect(result).toMatchObject({ action: "abort", handlerFailed: true });
    },
  );

  it.each(["PreRuntime", "PreStateCommit"] as const)(
    "%s fails closed for the owner's own subject and is skipped for another's",
    async (event) => {
      expect(
        await failOnce(event, {
          owner: "aux",
          subject: "aux",
          storyPluginIds: withStory,
        }),
      ).toMatchObject({ action: "abort", handlerFailed: true });
      const other = await failOnce(event, {
        owner: "aux",
        subject: "teller",
        storyPluginIds: withStory,
      });
      expect(other.action).toBe("continue");
      expect(other).toMatchObject({
        confined: [{ pluginId: "aux", reason: "hook bug" }],
      });
    },
  );

  it("TurnStart reports the owner whose runtimes sit the turn out", async () => {
    const result = await failOnce("TurnStart", {
      owner: "aux",
      storyPluginIds: withStory,
    });
    expect(result).toMatchObject({
      action: "continue",
      confined: [{ pluginId: "aux", reason: "hook bug" }],
    });
  });

  it.each(Object.keys(GUARD_FAILURE_SCOPE) as HookEvent[])(
    "%s fails closed without a story, for the story plugin and for a framework hook",
    async (event) => {
      for (const options of [
        { owner: "aux", subject: "teller" },
        { owner: "teller", subject: "aux", storyPluginIds: withStory },
        { subject: "aux", storyPluginIds: withStory },
      ])
        expect(await failOnce(event, options)).toMatchObject({
          action: "abort",
          handlerFailed: true,
        });
    },
  );
});
