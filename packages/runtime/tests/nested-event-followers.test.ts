import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMemoryStore } from "@covel/store/memory";
import type { RuntimeManifest, TurnResult } from "@covel/shared";
import type {
  FunctionHandler,
  LoadedRuntime,
} from "@covel/shared/plugin-runtime";
import type { HandlerResult } from "@covel/plugin-handlers-utils";
import {
  committedEventFollowers,
  commitExecution,
  executeTurn,
  refuseReleasedJobs,
  resumeSuspendedRuntime,
} from "../src/index.js";

type Follower = NonNullable<TurnResult["deferredFollowers"]>[number];
beforeEach(() => {
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

function manifest(
  id: string,
  extra: Partial<RuntimeManifest> = {},
): RuntimeManifest {
  return {
    name: `probe/${id}`,
    pluginId: "probe",
    description: id,
    runtimeType: "function",
    stage: "post-turn",
    outputKind: "system",
    trigger: { type: "manual" },
    ...extra,
  };
}
const success = (): HandlerResult => ({ outcome: "success", value: {} });
const event = (n: number): HandlerResult => {
  const data = { n };
  return {
    outcome: "success",
    value: data,
    effects: { events: [{ topic: "probe.changed", data }] },
  };
};

async function fixture(
  options: {
    failure?: "failed" | "throws";
    repeat?: boolean;
    siblings?: boolean;
    suspended?: boolean;
    resuspend?: boolean;
  } = {},
) {
  const store = createMemoryStore();
  const now = new Date().toISOString();
  await store.createSession({
    id: "s",
    locale: "en-US",
    status: "active",
    phase: "playing",
    completedPlayerTurns: 0,
    setupRuntimes: {},
    activePlugins: ["probe"],
    seats: [
      { id: "main", controller: "human", role: "player", characters: "auto" },
    ],
    createdAt: now,
    updatedAt: now,
  });
  const story = manifest("story", {
    stage: "narrative",
    outputKind: "story",
    trigger: { type: "auto" },
  });
  const parent = manifest("parent", { trigger: { type: "auto" } });
  const sibling = manifest("sibling", { trigger: { type: "auto" } });
  const top = manifest("top", { trigger: { type: "auto" } });
  const child = manifest("child");
  const follower = manifest("follower", {
    execution: "background",
    trigger: { type: "event", topic: "probe.changed" },
  });
  const runtimes = [
    story,
    parent,
    child,
    follower,
    ...(options.siblings ? [sibling, top] : []),
  ];
  let sequence = 0;
  let resuspend = options.resuspend ?? false;
  const handler =
    (runtime: RuntimeManifest): FunctionHandler =>
    async (ctx): Promise<HandlerResult> => {
      if (runtime.name === story.name)
        return {
          outcome: "success",
          value: { narrativeOutput: "The scene continues." },
        };
      if (runtime.name === top.name) return event(100);
      if (runtime.name === child.name) return event(++sequence);
      if (runtime.name === follower.name)
        throw new Error("Follower must be deferred");
      if (ctx.resumedFromSuspensionId !== undefined) {
        if (resuspend) {
          resuspend = false;
          return {
            outcome: "suspended",
            reason: "One more answer",
            resumeSchema: {},
          };
        }
        return success();
      }
      const nested = await ctx.recursiveCall({
        manualTrigger: { runtimeId: child.name },
      });
      // Plugin mutation cannot rewrite the kernel's queued payload.
      const visible = nested.runtimeResults.find(
        (result) => result.runtimeId === child.name,
      )?.output;
      if (visible) (visible as Record<string, unknown>).n = -1;
      if (options.repeat)
        await ctx.recursiveCall({ manualTrigger: { runtimeId: child.name } });
      await ctx.pluginData!.set("state", runtime.name, true);
      if (options.failure === "throws") throw new Error("Parent failed");
      if (options.failure === "failed")
        return { outcome: "failed", error: "Parent failed" };
      if (options.suspended)
        return { outcome: "suspended", reason: "An answer", resumeSchema: {} };
      return success();
    };
  const deps = {
    store,
    llm: { generate: vi.fn() },
    loadRuntime: async (runtime: RuntimeManifest): Promise<LoadedRuntime> => ({
      manifest: runtime,
      promptTemplate: "",
      handler: handler(runtime),
    }),
  };
  const execution = await executeTurn(
    {
      sessionId: "s",
      turnId: "t",
      playerMessage: "Continue",
      origin: "player",
    },
    runtimes,
    deps,
  );
  return { store, deps, runtimes, execution, parent };
}

async function commit(
  f: Awaited<ReturnType<typeof fixture>>,
  rejectParent = false,
) {
  let queued: Follower[] = [];
  const outcome = await commitExecution({
    store: f.store,
    execution: structuredClone(f.execution),
    enqueueReleasedJobsInTx: refuseReleasedJobs,
    completion: { kind: "turn", turnId: "t", durationMs: 0 },
    proposalGuard: (proposal) =>
      rejectParent && proposal.source.runtimeId === f.parent.name
        ? "Reject parent"
        : undefined,
    extraInTx: async (_tx, isolation) => {
      queued = committedEventFollowers(
        f.execution.result.deferredFollowers ?? [],
        isolation.followerSources,
        isolation.droppedRunIds,
      );
    },
  });
  return { queued, outcome };
}

describe("background followers from recursive calls", () => {
  it("preserves the selected nested payload with a successful parent", async () => {
    const f = await fixture();
    const { outcome, queued } = await commit(f);
    expect(outcome.status).toBe("committed");
    expect(queued).toHaveLength(1);
    expect(queued[0]?.triggerEvent.data).toEqual({ n: 1 });
    expect(f.execution.commit.eventDependencies?.followers).toEqual([
      f.execution.commit.results.find((r) => r.runtimeId === "probe/child")!
        .runId,
    ]);
    await f.store.close();
  });

  it.each(["failed", "throws"] as const)(
    "discards followers when the parent %s",
    async (failure) => {
      const f = await fixture({ failure });
      const { outcome, queued } = await commit(f);
      expect(outcome.status).toBe("committed");
      expect(f.execution.result.deferredFollowers).toBeUndefined();
      expect(queued).toEqual([]);
      await f.store.close();
    },
  );

  it("keeps each nested and top-level activation paired with its own run when one parent drops", async () => {
    const f = await fixture({ repeat: true, siblings: true });
    const emitted = f.execution.result.deferredFollowers!;
    expect(emitted).toHaveLength(5);
    expect(new Set(emitted.map((item) => item.runtimeId))).toEqual(
      new Set(["probe/follower"]),
    );
    const expectedSources = emitted.map(
      (item) =>
        f.execution.commit.results.find((result) =>
          (
            result.effects?.events as { data: { n: number } }[] | undefined
          )?.some((event) => event.data.n === item.triggerEvent.data.n),
        )!.runId,
    );
    expect(f.execution.commit.eventDependencies?.followers).toEqual(
      expectedSources,
    );
    expect(new Set(expectedSources).size).toBe(5);
    const { outcome, queued } = await commit(f, true);
    expect(outcome.status).toBe("committed");
    expect(queued).toHaveLength(3);
    expect(queued.some((item) => item.triggerEvent.data.n === 100)).toBe(true);
    const dropped = new Set(
      outcome.isolatedRuntimes?.map((item) => item.runId),
    );
    expect(queued).toEqual(
      emitted.filter((_item, index) => !dropped.has(expectedSources[index])),
    );
    await f.store.close();
  });

  it.each([false, true])(
    "holds nested followers until successful resume (resuspend=%s)",
    async (resuspend) => {
      const f = await fixture({ suspended: true, resuspend });
      const initial = await commit(f);
      expect(initial.outcome.status).toBe("committed");
      expect(initial.queued).toEqual([]);
      let [saved] = (await f.store.listSuspensions("s")).filter(
        (row) => !row.resolvedAt,
      );
      expect(
        saved!.pendingContinuation.nestedResults?.[0]?.deferredFollowers,
      ).toHaveLength(1);
      const sourceRun = (
        saved!.pendingContinuation.nestedResults![0]!.result as {
          runId: string;
        }
      ).runId;
      for (let attempt = 0; attempt < (resuspend ? 2 : 1); attempt++) {
        expect(await f.store.claimSuspension(saved!.id)).not.toBeNull();
        const resumed = await resumeSuspendedRuntime(
          saved!,
          {},
          f.parent,
          f.deps,
          { activeRuntimes: f.runtimes },
        );
        let queued: Follower[] = [];
        const outcome = await commitExecution({
          store: f.store,
          execution: structuredClone(resumed),
          enqueueReleasedJobsInTx: refuseReleasedJobs,
          completion: {
            kind: "resume",
            turnId: "t",
            suspensionId: saved!.id,
            pluginId: "probe",
            runtimeId: f.parent.name,
          },
          extraInTx: async (_tx, isolation) => {
            queued = committedEventFollowers(
              resumed.commit.deferredFollowers ?? [],
              isolation.followerSources,
              isolation.droppedRunIds,
            );
          },
        });
        expect(outcome.status).toBe("committed");
        if (resumed.result.status === "suspended") {
          expect(queued).toEqual([]);
          [saved] = (await f.store.listSuspensions("s")).filter(
            (row) => !row.resolvedAt,
          );
        } else {
          expect(queued).toHaveLength(1);
          expect(queued[0]?.triggerEvent.data).toEqual({ n: 1 });
          expect(resumed.commit.eventDependencies?.followers).toEqual([
            sourceRun,
          ]);
        }
      }
      expect(
        (await f.store.listSuspensions("s")).filter((row) => !row.resolvedAt),
      ).toEqual([]);
      await f.store.close();
    },
  );
});
