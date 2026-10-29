/**
 * Characterization of the execution scaffold at commit: buffered writes and
 * nested `ctx.recursiveCall` results follow the invocation lease. The lease
 * drains un-awaited nested calls before the result reads `nestedResults`, so
 * a child the handler did not await still commits with a successful parent.
 */

import { describe, expect, it, vi } from "vitest";
import { createMemoryStore } from "@covel/store/memory";
import type {
  HandlerResult,
  JsonValue,
  Proposal,
  RuntimeManifest,
  RuntimeResult,
} from "@covel/shared";
import type {
  FunctionHandler,
  FunctionHandlerContext,
  LoadedRuntime,
} from "@covel/shared/plugin-runtime";
import {
  commitExecution,
  createHookPipeline,
  executeTurn,
} from "../src/index.js";
import type { HookPipeline } from "../src/hooks/pipeline.js";

const SESSION = "session";
const input = {
  sessionId: SESSION,
  turnId: "turn",
  logicalTurnId: "logical-turn",
  playerMessage: "Continue",
  origin: "player" as const,
};

function manifest(
  id: string,
  extra: Partial<RuntimeManifest> = {},
): RuntimeManifest {
  return {
    name: `probe/${id}`,
    pluginId: "probe",
    description: id,
    runtimeType: "function",
    stage: "narrative",
    outputKind: "system",
    trigger: { type: "manual" },
    ...extra,
  } as RuntimeManifest;
}

const ok = (value: Record<string, JsonValue> = {}): HandlerResult => ({
  outcome: "success",
  value,
});

const later = () => new Promise<void>((resolve) => setTimeout(resolve, 10));

function launch(ctx: FunctionHandlerContext, id: string) {
  return ctx.recursiveCall({ manualTrigger: { runtimeId: `probe/${id}` } });
}

async function note(ctx: FunctionHandlerContext, key: string) {
  await ctx.pluginData!.set("notes", key, key);
}

/** A child that writes only after its parent has returned. */
const lateChild: FunctionHandler = async (ctx) => {
  await later();
  await note(ctx, "child");
  return ok();
};

function observePost(hookPipeline: HookPipeline) {
  const posted: RuntimeResult[] = [];
  hookPipeline.register({
    id: "observe-post",
    event: "PostRuntime",
    async handler(_context, payload) {
      posted.push(
        structuredClone((payload as { result: RuntimeResult }).result),
      );
      return { action: "continue" };
    },
  });
  return posted;
}

function replaceStatus(
  hookPipeline: HookPipeline,
  runtimeId: string,
  from: RuntimeResult["status"],
  to: RuntimeResult["status"],
) {
  hookPipeline.register({
    id: `${from}-to-${to}`,
    event: "PostRuntime",
    async handler(_context, payload) {
      const { result } = payload as { result: RuntimeResult };
      if (result.runtimeId !== runtimeId || result.status !== from)
        return { action: "continue" };
      return {
        action: "continue",
        replace: {
          result: {
            ...result,
            status: to,
            output: to === "success" ? { ok: true } : null,
            ...(to === "failed" ? { error: "downgraded" } : {}),
          },
        },
      };
    },
  });
}

async function run(
  runtimes: readonly RuntimeManifest[],
  handlers: Record<string, FunctionHandler>,
  options: {
    readonly hookPipeline?: HookPipeline;
    readonly guards?: Record<string, LoadedRuntime["guard"]>;
  } = {},
) {
  const store = createMemoryStore();
  const timestamp = "2026-10-29T00:00:00.000Z";
  await store.createSession({
    id: SESSION,
    locale: "en-US",
    status: "active",
    phase: "playing",
    setupRuntimes: {},
    activePlugins: ["probe"],
    completedPlayerTurns: 0,
    createdAt: timestamp,
    updatedAt: timestamp,
  });
  const execution = await executeTurn(input, runtimes, {
    store,
    llm: {
      generate: vi.fn(async () => ({ content: "{}", toolCalls: [] })),
    } as never,
    ...(options.hookPipeline ? { hookPipeline: options.hookPipeline } : {}),
    loadRuntime: async (runtime) => ({
      manifest: runtime,
      promptTemplate: "",
      ...(options.guards?.[runtime.name]
        ? { guard: options.guards[runtime.name] }
        : {}),
      handler: handlers[runtime.name],
    }),
  });
  const outcome = await commitExecution({
    store,
    execution,
    completion: { kind: "turn", turnId: input.turnId, durationMs: 0 },
  });
  const notes = Object.fromEntries(
    (await store.listPluginData(SESSION, "probe", "notes")).map((row) => [
      row.key,
      row.value,
    ]),
  );
  return { store, execution, outcome, notes };
}

const ids = (results: readonly { readonly runtimeId: string }[]) =>
  results.map((result) => result.runtimeId);

const noteKeys = (proposals: readonly Proposal[] | undefined) =>
  (proposals ?? []).map(
    (proposal) => (proposal.payload as { readonly key?: string }).key,
  );

describe("function buffered writes and PostRuntime", () => {
  it("commits nothing when PostRuntime recovers a failed handler", async () => {
    const parent = manifest("parent", { trigger: { type: "auto" } });
    const hookPipeline = createHookPipeline();
    replaceStatus(hookPipeline, parent.name, "failed", "success");
    const { execution, notes } = await run(
      [parent],
      {
        [parent.name]: async (ctx) => {
          await note(ctx, "parent");
          return { outcome: "failed", error: "gave up" };
        },
      },
      { hookPipeline },
    );
    expect(execution.commit.results[0]?.status).toBe("success");
    expect(notes).toEqual({});
  });

  it("commits nothing when PostRuntime downgrades a successful handler", async () => {
    const parent = manifest("parent", { trigger: { type: "auto" } });
    const hookPipeline = createHookPipeline();
    replaceStatus(hookPipeline, parent.name, "success", "failed");
    const { execution, notes } = await run(
      [parent],
      {
        [parent.name]: async (ctx) => {
          await note(ctx, "parent");
          return ok();
        },
      },
      { hookPipeline },
    );
    expect(execution.commit.results[0]?.status).toBe("failed");
    expect(notes).toEqual({});
  });

  it("hides a function's buffered writes from PostRuntime but shows a skipped guard's", async () => {
    const fn = manifest("fn", { trigger: { type: "auto" } });
    const guarded = manifest("guarded", {
      runtimeType: "agent",
      trigger: { type: "auto" },
    });
    const hookPipeline = createHookPipeline();
    const posted = observePost(hookPipeline);
    const { notes } = await run(
      [fn, guarded],
      {
        [fn.name]: async (ctx) => {
          await note(ctx, "fn");
          return ok();
        },
      },
      {
        hookPipeline,
        guards: {
          [guarded.name]: async (ctx) => {
            await note(ctx, "guard");
            return { skip: true };
          },
        },
      },
    );
    const byRuntime = (name: string) =>
      posted.find((result) => result.runtimeId === name);
    expect(byRuntime(fn.name)).not.toHaveProperty("pendingProposals");
    expect(noteKeys(byRuntime(guarded.name)?.pendingProposals)).toEqual([
      "guard",
    ]);
    expect(notes).toEqual({ fn: "fn", guard: "guard" });
  });
});

describe("un-awaited nested calls and the lease", () => {
  it("commits a child the successful parent did not await", async () => {
    const parent = manifest("parent", { trigger: { type: "auto" } });
    const child = manifest("child");
    const { execution, outcome, notes } = await run([parent, child], {
      [parent.name]: async (ctx) => {
        void launch(ctx, "child");
        return ok();
      },
      [child.name]: lateChild,
    });
    expect(outcome.status).toBe("committed");
    expect(ids(execution.commit.results)).toEqual([child.name, parent.name]);
    expect(notes).toEqual({ child: "child" });
  });

  it("drops an un-awaited child's writes when the parent times out", async () => {
    const parent = manifest("parent", {
      trigger: { type: "auto" },
      timeoutMs: 40,
    });
    const child = manifest("child");
    const release = Promise.withResolvers<void>();
    try {
      const { execution, notes } = await run([parent, child], {
        [parent.name]: async (ctx) => {
          void launch(ctx, "child");
          await release.promise;
          return ok();
        },
        [child.name]: lateChild,
      });
      expect(execution.commit.results).toEqual([
        expect.objectContaining({
          runtimeId: parent.name,
          status: "failed",
          error: 'function runtime "probe/parent" timed out after 40ms',
        }),
      ]);
      expect(execution.result.nestedRuntimeResults).toBeUndefined();
      expect(notes).toEqual({});
    } finally {
      release.resolve();
    }
  });

  it.each([true, false])(
    "commits a guard's un-awaited child only when the guard skips (skip=%s)",
    async (skip) => {
      const guarded = manifest("guarded", {
        runtimeType: "agent",
        trigger: { type: "auto" },
      });
      const child = manifest("child");
      const { execution, notes } = await run(
        [guarded, child],
        { [child.name]: lateChild },
        {
          guards: {
            [guarded.name]: async (ctx) => {
              void launch(ctx, "child");
              return { skip };
            },
          },
        },
      );
      expect(ids(execution.commit.results)).toEqual(
        skip ? [child.name, guarded.name] : [guarded.name],
      );
      expect(notes).toEqual(skip ? { child: "child" } : {});
    },
  );
});

describe("suspension and nested calls", () => {
  it("saves a suspending parent's own buffer only; its child's writes are dropped", async () => {
    const parent = manifest("parent", { trigger: { type: "auto" } });
    const child = manifest("child");
    const { store, execution, outcome, notes } = await run([parent, child], {
      [parent.name]: async (ctx) => {
        await launch(ctx, "child");
        await note(ctx, "parent");
        return { outcome: "suspended", reason: "input" } as HandlerResult;
      },
      [child.name]: async (ctx) => {
        await note(ctx, "child");
        return ok();
      },
    });
    expect(outcome.status).toBe("committed");
    const parentResult = execution.result.runtimeResults.find(
      (result) => result.runtimeId === parent.name,
    );
    expect(parentResult?.status).toBe("suspended");
    expect(execution.result.nestedRuntimeResults).toBeUndefined();
    const [record] = execution.commit.suspensions ?? [];
    expect(execution.commit.suspensionRuns).toEqual({
      [record!.id]: parentResult!.runId,
    });
    const saved = await store.listSuspensions(SESSION);
    expect(saved.map((item) => item.id)).toEqual([record!.id]);
    expect(
      noteKeys(saved[0]!.pendingContinuation.pendingProposals as Proposal[]),
    ).toEqual(["parent"]);
    expect(notes).toEqual({});
  });
});
