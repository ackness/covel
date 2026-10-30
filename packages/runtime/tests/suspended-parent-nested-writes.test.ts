/**
 * A function that suspends after `ctx.recursiveCall` keeps its children's
 * writes: they are saved with its suspension and commit with its successful
 * resume, children first, as one unit, and they are dropped wherever its own
 * buffered writes would be.
 */

import { describe, expect, it, vi } from "vitest";
import type {
  HandlerResult,
  JsonValue,
  RuntimeManifest,
  RuntimeResult,
} from "@covel/shared";
import type {
  FunctionHandler,
  FunctionHandlerContext,
} from "@covel/shared/plugin-runtime";
import { createMemoryStore } from "@covel/store/memory";
import {
  applySuspensionAbandonTx,
  commitExecution,
  createHookPipeline,
  executeTurn,
  planSuspensionAbandon,
  resumeSuspendedRuntime,
} from "../src/index.js";
import type { HookPipeline } from "../src/hooks/pipeline.js";
import type { TurnEmitter } from "../src/trace/turn-emitter.js";
import { readRuntimeTriggerLedger } from "../src/trigger/trigger-ledger.js";

const SESSION = "session";
const timestamp = "2026-10-29T00:00:00.000Z";
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

const parent = manifest("parent", { trigger: { type: "auto" } });
const child = manifest("child");
const runtimes = [parent, child];

const ok = (value: Record<string, JsonValue> = {}): HandlerResult => ({
  outcome: "success",
  value,
});

async function note(ctx: FunctionHandlerContext, key: string) {
  await ctx.pluginData!.set("notes", key, key);
}

/** The child writes B and asks a question the player answers through the parent. */
const childHandler: FunctionHandler = async (ctx) => {
  await note(ctx, "B");
  return {
    outcome: "success",
    value: { content: "Pick one" },
    effects: { interactions: [{ interactionId: "pick", type: "form" }] },
  };
};

/** The parent calls the child, writes A and, unless told not to, suspends. */
function parentHandler(suspends: boolean): FunctionHandler {
  return async (ctx) => {
    if (ctx.resumedFromSuspensionId === undefined) {
      await ctx.recursiveCall({ manualTrigger: { runtimeId: child.name } });
      await note(ctx, "A");
      if (suspends)
        return {
          outcome: "suspended",
          reason: "Need an answer",
          resumeSchema: { type: "object" },
        };
    }
    return ok();
  };
}

async function fixture(
  options: {
    readonly suspends?: boolean;
    readonly child?: FunctionHandler;
    readonly hookPipeline?: HookPipeline;
  } = {},
) {
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
    activePlugins: ["probe"],
    completedPlayerTurns: 0,
    createdAt: timestamp,
    updatedAt: timestamp,
  });
  const traces: { type: string; payload: Record<string, unknown> }[] = [];
  const emitter = {
    sessionId: SESSION,
    turnId: input.turnId,
    async emit(type: string, payload: Record<string, unknown>) {
      traces.push({ type, payload });
    },
  } as unknown as TurnEmitter;
  const handlers: Record<string, FunctionHandler> = {
    [parent.name]: parentHandler(options.suspends ?? true),
    [child.name]: options.child ?? childHandler,
  };
  const deps = {
    store,
    emitter,
    llm: { generate: vi.fn() } as never,
    ...(options.hookPipeline ? { hookPipeline: options.hookPipeline } : {}),
    loadRuntime: async (runtime: RuntimeManifest) => ({
      manifest: runtime,
      promptTemplate: "",
      handler: handlers[runtime.name],
    }),
  };
  const execution = await executeTurn(input, runtimes, deps);
  const outcome = await commitExecution({
    store,
    execution,
    completion: { kind: "turn", turnId: input.turnId, durationMs: 0 },
  });
  expect(outcome.status).toBe("committed");
  const keys = async () =>
    (await store.listPluginData(SESSION, "probe", "notes"))
      .map((row) => row.key)
      .sort();
  const childRows = async () =>
    (await store.listTurnMessages(SESSION)).filter(
      (row) => row.sourceRuntimeId === child.name,
    );
  const childTriggers = async () =>
    (await readRuntimeTriggerLedger(store, SESSION)).get(child.name)?.count ??
    0;
  const [suspension] = await store.listSuspensions(SESSION);
  return {
    store,
    deps,
    traces,
    execution,
    suspension,
    keys,
    childRows,
    childTriggers,
  };
}

function commitResume(
  f: Awaited<ReturnType<typeof fixture>>,
  resumed: Awaited<ReturnType<typeof resumeSuspendedRuntime>>,
) {
  return commitExecution({
    store: f.store,
    execution: structuredClone(resumed),
    completion: {
      kind: "resume",
      turnId: f.suspension!.turnId,
      suspensionId: f.suspension!.id,
      pluginId: f.suspension!.pluginId,
      runtimeId: f.suspension!.runtimeId,
    },
  });
}

describe("nested writes of a suspended parent", () => {
  it("wait with the suspension and commit with its resume, children first", async () => {
    const f = await fixture();
    expect(await f.keys()).toEqual([]);
    const nested = f.suspension!.pendingContinuation.nestedResults ?? [];
    expect(nested).toHaveLength(1);
    expect(nested[0]!.result).toMatchObject({
      runtimeId: child.name,
      status: "success",
      pendingProposals: [
        expect.objectContaining({
          type: "plugin.data",
          payload: expect.objectContaining({ key: "B" }),
        }),
      ],
    });

    const resumed = await resumeSuspendedRuntime(
      f.suspension!,
      {},
      parent,
      f.deps,
      { activeRuntimes: runtimes },
    );
    expect(resumed.result.status).toBe("success");
    expect(resumed.commit.results.map((result) => result.runtimeId)).toEqual([
      child.name,
      parent.name,
    ]);
    expect(resumed.commit.commitUnits).toEqual([2]);
    expect((await commitResume(f, resumed)).status).toBe("committed");
    expect(await f.keys()).toEqual(["A", "B"]);

    // The child's conversation row and trigger count are what the same
    // parent leaves when it succeeds without suspending.
    const direct = await fixture({ suspends: false });
    expect(await direct.keys()).toEqual(["A", "B"]);
    expect((await direct.childRows()).length).toBe(1);
    expect((await f.childRows()).length).toBe(
      (await direct.childRows()).length,
    );
    expect((await f.childRows())[0]).toMatchObject({
      pendingInput: [expect.objectContaining({ interactionId: "pick" })],
    });
    expect(await direct.childTriggers()).toBe(1);
    expect(await f.childTriggers()).toBe(await direct.childTriggers());
  });

  it("voids the resume when a nested write's target changed after the suspension", async () => {
    const f = await fixture();
    await f.store.setPluginData({
      id: "manual-write",
      sessionId: SESSION,
      pluginId: "probe",
      namespace: "notes",
      key: "B",
      value: "written by a manual run",
      createdAt: timestamp,
      updatedAt: timestamp,
    });
    const resumed = await resumeSuspendedRuntime(
      f.suspension!,
      {},
      parent,
      f.deps,
      { activeRuntimes: runtimes },
    );
    const outcome = await commitResume(f, resumed);
    expect(outcome.code).toBe("suspension-data-changed");
    expect(await f.keys()).toEqual(["B"]);
    expect(
      (await f.store.getPluginData(SESSION, "probe", "notes", "B"))?.value,
    ).toBe("written by a manual run");
  });

  it("are dropped when PostRuntime turns the resumed parent's success into failure", async () => {
    const hookPipeline = createHookPipeline();
    hookPipeline.register({
      id: "fail-resumed-parent",
      event: "PostRuntime",
      handler: async (_context, payload) => {
        const { result, resumed } = payload as {
          result: RuntimeResult;
          resumed?: boolean;
        };
        if (!resumed || result.runtimeId !== parent.name)
          return { action: "continue" };
        return {
          action: "continue",
          replace: {
            result: { ...result, status: "failed", error: "vetoed" },
          },
        };
      },
    });
    const f = await fixture({ hookPipeline });
    const resumed = await resumeSuspendedRuntime(
      f.suspension!,
      {},
      parent,
      f.deps,
      { activeRuntimes: runtimes },
    );
    expect(resumed.result.status).toBe("failed");
    expect(resumed.commit.results.map((result) => result.runtimeId)).toEqual([
      parent.name,
    ]);
    expect(resumed.commit.results[0]?.pendingProposals).toBeUndefined();
    expect(await f.keys()).toEqual([]);
  });

  it("are dropped when the suspension is abandoned", async () => {
    const f = await fixture();
    const plan = await planSuspensionAbandon(f.store, f.suspension!);
    await f.store.withTransaction((tx) =>
      applySuspensionAbandonTx(tx, plan, timestamp),
    );
    expect(await f.keys()).toEqual([]);
    expect(
      (await f.store.listSuspensions(SESSION)).filter(
        (record) => record.resolvedAt === undefined,
      ),
    ).toEqual([]);
  });

  it("leave out a nested run that itself suspended, and trace it", async () => {
    const f = await fixture({
      child: async (ctx) => {
        await note(ctx, "B");
        return {
          outcome: "suspended",
          reason: "The child asks too",
          resumeSchema: { type: "object" },
        };
      },
    });
    expect(await f.store.listSuspensions(SESSION)).toHaveLength(1);
    expect(f.suspension!.runtimeId).toBe(parent.name);
    expect(f.suspension!.pendingContinuation.nestedResults).toBeUndefined();
    expect(
      f.traces.filter(
        (trace) => trace.payload.code === "nested-suspension-dropped",
      ),
    ).toEqual([
      {
        type: "recursive.failed",
        payload: expect.objectContaining({
          runtimeId: parent.name,
          nestedRuntimeId: child.name,
        }),
      },
    ]);
  });
});
