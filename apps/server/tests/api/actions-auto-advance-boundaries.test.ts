import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createHookPipeline } from "@covel/runtime";
import { pluginFaultHost } from "../../src/routes/api/plugin-faults.js";
import { advanceFixture, events } from "./__helpers/auto-advance.js";
vi.mock("@hono/node-server/conninfo", () => ({
  getConnInfo: () => ({ remote: { address: "127.0.0.1" } }),
}));
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});
describe("advancement execution boundaries", () => {
  it("returns control to an unanswered interaction before starting another round", async () => {
    const f = await advanceFixture();
    const add = f.store.addTraceEvent.bind(f.store);
    vi.spyOn(f.store, "addTraceEvent").mockImplementation(async (event) => {
      await add(event);
      if (
        event.type === "execution.advance" &&
        (event.payload as { phase: string }).phase === "waiting"
      )
        await f.store.appendTurnMessage({
          id: "question",
          sessionId: f.sessionId,
          turnId: event.turnId!,
          sourceType: "runtime",
          sourcePluginId: "observer",
          role: "assistant",
          content: "",
          order: 1,
          createdAt: new Date().toISOString(),
          pendingInput: [
            {
              interactionId: "route",
              type: "form",
              title: "Choose a route",
              submitLabel: "Go",
              fields: [{ type: "text", name: "route", label: "Route" }],
              narrativeTemplate: "{{route}}",
            },
          ],
        });
    });
    try {
      const stream = events(await (await f.post()).text());
      expect(f.calls()).toBe(1);
      expect(
        stream.filter((event) => event.type === "execution.started"),
      ).toHaveLength(1);
      expect(
        stream.filter((event) => event.type === "execution.advance").at(-1)
          ?.payload.reason,
      ).toBe("pending-input");
    } finally {
      await f.close();
    }
  });
  it("keeps the last committed outcome when admission of the next round fails", async () => {
    const f = await advanceFixture();
    const add = f.store.addTraceEvent.bind(f.store);
    vi.spyOn(f.store, "addTraceEvent").mockImplementation(async (event) => {
      await add(event);
      if (
        event.type === "execution.advance" &&
        (event.payload as { phase: string }).phase === "waiting"
      )
        vi.spyOn(f.store, "listSuspensions").mockRejectedValueOnce(
          new Error("Admission read unavailable"),
        );
    });
    try {
      const stream = events(await (await f.post()).text());
      expect(f.calls()).toBe(1);
      expect(
        stream.filter((event) => event.type === "execution.round.completed"),
      ).toHaveLength(1);
      expect(stream.at(-1)).toMatchObject({
        type: "execution.completed",
        payload: { committed: true },
      });
      expect(
        (await f.store.queryTurnResults(f.sessionId, {})).map(
          (row) => row.commitStatus,
        ),
      ).toEqual(["committed"]);
      expect(
        stream.filter((event) => event.type === "execution.advance").at(-1)
          ?.payload.reason,
      ).toBe("prerequisite-unavailable");
    } finally {
      await f.close();
    }
  });
  it("resumes a suspended automatic round once with its original system action and clock", async () => {
    const f = await advanceFixture({
      prepare: async (builtin) => {
        await writeFile(
          join(builtin, "observer", "handler.mjs"),
          `export default async function(ctx){
    if(ctx.playerActions.some(action=>action.source==="system")&&!ctx.resumedFromSuspensionId)
      return {outcome:"suspended",reason:"Choose a route",resumeSchema:{type:"object",properties:{route:{type:"string"}},required:["route"]}};
    return {outcome:"success",value:{},effects:{pluginData:[{namespace:"rounds",key:ctx.turnId,value:{logicalTurn:ctx.logicalTurn,actions:ctx.playerActions}}]}};
   }`,
        );
      },
    });
    try {
      const stream = events(await (await f.post()).text());
      expect(
        stream.filter((event) => event.type === "execution.started"),
      ).toHaveLength(2);
      expect(f.calls()).toBe(2);
      const suspension = (await f.store.listSuspensions(f.sessionId)).find(
        (row) => !row.resolvedAt,
      );
      expect(suspension).toBeDefined();
      expect(suspension?.pendingContinuation.actions).toEqual([
        { kind: "advance", source: "system", seatId: "human" },
      ]);
      expect(suspension?.pendingContinuation.executionContext).toMatchObject({
        origin: "continuation",
        logicalTurn: 5,
        countPolicy: "none",
      });
      const resume = await f.boot.app.request(
        `/api/sessions/${f.sessionId}/suspensions/${suspension!.id}/resume`,
        {
          method: "POST",
          headers: f.headers,
          body: JSON.stringify({ data: { route: "left" } }),
        },
      );
      expect(resume.status).toBe(200);
      expect(await resume.json()).toMatchObject({
        result: { status: "success" },
      });
      const observations = await f.store.listPluginData(
        f.sessionId,
        "observer",
        "rounds",
      );
      expect(observations.map((row) => row.value)).toContainEqual({
        logicalTurn: 5,
        actions: [{ kind: "advance", source: "system", seatId: "human" }],
      });
      expect(
        (await f.store.getSession(f.sessionId))?.completedPlayerTurns,
      ).toBe(5);
      expect(f.calls()).toBe(2);
      const recovered = await f.status();
      expect(recovered.state).toBe("completed");
      expect(recovered.advance).toBeUndefined();
      expect(
        (await f.store.listSuspensions(f.sessionId)).filter(
          (row) => !row.resolvedAt,
        ),
      ).toEqual([]);
    } finally {
      await f.close();
    }
  });
  it("retains a previous fault streak through the root's clean run until an automatic run faults", async () => {
    const f = await advanceFixture({
      yields: ["continue", "continue", "user"],
      prepare: async (builtin) => {
        await writeFile(
          join(builtin, "observer", "handler.mjs"),
          `let calls=0;export default async function(){ if(++calls===2)throw new Error("probe failed");return {outcome:"success",value:{}};}`,
        );
      },
    });
    try {
      const latch = pluginFaultHost(f.boot.store)!.latch;
      latch.recordHookFault(f.sessionId, "observer", "prior-one", "hook");
      latch.recordHookFault(f.sessionId, "observer", "prior-two", "hook");
      const stream = events(await (await f.post()).text());
      expect(
        stream.filter((event) => event.type === "plugin.fault.latched"),
      ).toHaveLength(1);
      expect(latch.latched(f.sessionId)).toMatchObject([
        { pluginId: "observer", consecutiveFaults: 3 },
      ]);
      expect(
        stream.filter((event) => event.type === "execution.started"),
      ).toHaveLength(3);
      expect(
        (await f.store.listMessages(f.sessionId)).filter(
          (message) => message.role === "assistant",
        ),
      ).toHaveLength(3);
    } finally {
      await f.close();
    }
  });
  it("a recursive child's continue does not request another host execution", async () => {
    const f = await advanceFixture({
      noProvider: true,
      prepare: async (builtin, store, sessionId) => {
        const root = join(builtin, "recursive-probe");
        await mkdir(join(root, "runtimes", "parent"), { recursive: true });
        await mkdir(join(root, "runtimes", "child"));
        await writeFile(
          join(root, "PLUGIN.md"),
          "---\nid: recursive-probe\ndescription: Nested story probe\n---\n",
        );
        await writeFile(
          join(root, "runtimes", "parent", "RUNTIME.md"),
          "---\ndescription: Parent probe\nschedule: { stage: narrative }\nfunction: {}\n---\n",
        );
        await writeFile(
          join(root, "runtimes", "parent", "handler.js"),
          `export default async function(ctx){await ctx.recursiveCall({manualTrigger:{runtimeId:"recursive-probe/child"}});return {outcome:"success",value:{}};}`,
        );
        await writeFile(
          join(root, "runtimes", "child", "RUNTIME.md"),
          "---\ndescription: Child probe\nschedule: { trigger: { type: manual } }\nio: { visibility: story, output: { contract: narrative-engine@2 } }\nfunction: {}\n---\n",
        );
        await writeFile(
          join(root, "runtimes", "child", "handler.js"),
          `export default async function(ctx){return {outcome:"success",value:{segments:[{kind:"narration",text:"Child story"}],yield:"continue"},effects:{pluginData:[{namespace:"clock",key:"child",value:ctx.logicalTurn}]}};}`,
        );
        await store.updateSession(sessionId, {
          activePlugins: ["recursive-probe", "observer"],
        });
      },
    });
    try {
      const stream = events(await (await f.post()).text());
      expect(
        stream.filter((event) => event.type === "execution.started"),
      ).toHaveLength(1);
      expect(
        stream.filter((event) => event.type === "execution.advance").at(-1)
          ?.payload.reason,
      ).toBe("no-eligible-story");
      expect(
        (
          await f.store.getPluginData(
            f.sessionId,
            "recursive-probe",
            "clock",
            "child",
          )
        )?.value,
      ).toBe(5);
    } finally {
      await f.close();
    }
  });
  it("keeps concealed failures out of round events, recovery, public traces and results", async () => {
    const secret = "hidden-advancement-sentinel-6417";
    const f = await advanceFixture({
      limit: 1,
      prepare: async (builtin) => {
        await writeFile(
          join(builtin, "observer", "PLUGIN.md"),
          "---\nid: observer\ndescription: Private probe\nruntime:\n  schedule: { stage: post-turn }\n  io: { concealed: true }\n  function: { handler: ./handler.mjs }\n---\n",
        );
        await writeFile(
          join(builtin, "observer", "handler.mjs"),
          `export default async function(){throw new Error("${secret}");}`,
        );
      },
    });
    try {
      const stream = await (await f.post()).text();
      expect(stream).not.toContain(secret);
      expect(
        events(stream).filter((event) => event.type === "execution.started"),
      ).toHaveLength(2);
      const traces = await f.store.queryTraceEvents(f.sessionId, {});
      expect(JSON.stringify(traces)).not.toContain(secret);
      const turns = await f.boot.app.request(
        `/api/sessions/${f.sessionId}/turns`,
        { headers: f.headers },
      );
      expect(turns.status).toBe(200);
      expect(await turns.text()).not.toContain(secret);
      expect(JSON.stringify(await f.status())).not.toContain(secret);
    } finally {
      await f.close();
    }
  });
  it("settles each detached job before the next round and preserves source actions and clock", async () => {
    const f = await advanceFixture({
      yields: ["continue", "continue", "user"],
      prepare: async (builtin) => {
        await writeFile(
          join(builtin, "observer", "PLUGIN.md"),
          "---\nid: observer\ndescription: Settle probe\nruntime:\n  schedule: { stage: post-turn, detached: { settle: true, maxSettleWaitMs: 10000 } }\n  function: { handler: ./handler.mjs }\n  effects: { writes: [plugin-data:self:rounds] }\n---\n",
        );
      },
    });
    try {
      const stream = events(await (await f.post()).text());
      expect(
        stream.filter((event) => event.type === "execution.started"),
      ).toHaveLength(3);
      // The final job is allowed to finish after the request; the earlier two
      // must have committed for the next round to acquire its settled lock.
      const rows = await f.store.listPluginData(
        f.sessionId,
        "observer",
        "rounds",
      );
      expect(rows.length).toBeGreaterThanOrEqual(2);
      expect(
        rows.every(
          (row) => (row.value as { logicalTurn: number }).logicalTurn === 5,
        ),
      ).toBe(true);
      expect(
        rows.map((row) => (row.value as { actions: unknown }).actions),
      ).toContainEqual([
        { kind: "advance", source: "system", seatId: "human" },
      ]);
      const jobs = await f.store.listPluginData(
        f.sessionId,
        "observer",
        "_runtime_jobs",
      );
      expect(jobs).toHaveLength(3);
      const descriptors = jobs.map(
        (job) =>
          (
            job.value as {
              payload: {
                descriptor: { sourceTurnId: string; logicalTurn: number };
              };
            }
          ).payload.descriptor,
      );
      expect(new Set(descriptors.map((value) => value.sourceTurnId)).size).toBe(
        3,
      );
    } finally {
      await f.close();
    }
  });
  it("aggregates an early publication failure and exposes the same frozen number to hooks", async () => {
    const numbers: number[] = [];
    const hooks = createHookPipeline();
    hooks.register({
      id: "clock",
      event: "TurnStart",
      handler: async (ctx) => {
        if (ctx.logicalTurn !== undefined) numbers.push(ctx.logicalTurn);
        return { action: "continue" };
      },
    });
    const f = await advanceFixture({ yields: ["continue", "user"], hooks });
    const add = f.store.addTraceEvent.bind(f.store);
    let failed = false;
    vi.spyOn(f.store, "addTraceEvent").mockImplementation(async (event) => {
      if (event.type === "turn.completed" && !failed) {
        failed = true;
        throw new Error("trace unavailable");
      }
      await add(event);
    });
    try {
      const stream = events(await (await f.post()).text());
      expect(numbers).toEqual([5, 5]);
      expect(stream.at(-1)?.payload).toMatchObject({
        committed: true,
        resync: true,
      });
      expect(
        (await f.store.queryTurnResults(f.sessionId, {})).every(
          (row) => row.commitStatus === "committed",
        ),
      ).toBe(true);
    } finally {
      await f.close();
    }
  });
});
