import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { DataStore } from "@covel/store";
import { createInProcessSessionLock } from "../../src/lib/session-lock.js";
import { createSettledSessionLock } from "../../src/routes/api/plugin-rpc/settled-session-lock.js";
import * as turnControl from "../../src/routes/api/turn-control.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { advanceFixture, events, gate } from "./__helpers/auto-advance.js";
vi.mock("@hono/node-server/conninfo", () => ({
  getConnInfo: () => ({ remote: { address: "127.0.0.1" } }),
}));
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("request-owned advancement", () => {
  it.each(["waiting", "running"])(
    "new input owns the stream after interrupting an automatic round that is %s",
    async (phase) => {
      const reached = gate(),
        release = gate();
      const f = await advanceFixture({
        yields:
          phase === "waiting"
            ? ["continue", "user"]
            : ["continue", "continue", "user"],
        onGenerate: async (index, request) => {
          if (phase !== "running" || index !== 1) return;
          reached.resolve();
          await new Promise<void>((_, reject) => {
            const abort = () =>
              reject(new DOMException("Stopped", "AbortError"));
            if (request.signal?.aborted) abort();
            else
              request.signal?.addEventListener("abort", abort, { once: true });
          });
        },
      });
      const add = f.store.addTraceEvent.bind(f.store);
      let held = false;
      vi.spyOn(f.store, "addTraceEvent").mockImplementation(async (event) => {
        await add(event);
        if (
          phase === "waiting" &&
          !held &&
          event.type === "execution.advance" &&
          (event.payload as { phase: string }).phase === "waiting"
        ) {
          held = true;
          reached.resolve();
          await release.promise;
        }
      });
      try {
        const older = f.post().then((response) => response.text());
        await reached.promise;
        const newer = await (
          await f.post({ actions: [{ kind: "say", text: "Change course" }] })
        ).text();
        release.resolve();
        const oldStream = events(await older),
          newStream = events(newer);
        expect(
          oldStream.filter((event) => event.type === "execution.advance").at(-1)
            ?.payload.reason,
        ).toBe("new-input");
        expect(
          oldStream.filter((event) => event.type === "narrative.completed"),
        ).toHaveLength(1);
        expect(
          newStream.filter((event) => event.type === "narrative.completed"),
        ).toHaveLength(1);
        expect(
          newStream.filter((event) => event.type === "execution.started"),
        ).toHaveLength(1);
        expect(
          (await f.store.getSession(f.sessionId))?.completedPlayerTurns,
        ).toBe(6);
        expect(
          (await f.store.queryTurnResults(f.sessionId, {})).some(
            (row) => row.commitStatus === "pending",
          ),
        ).toBe(false);
        expect(await f.status()).toMatchObject({ state: "completed" });
      } finally {
        release.resolve();
        await f.close();
      }
    },
  );
  it("stops a waiting round without inventing a turn and reports the live gap", async () => {
    const f = await advanceFixture();
    const waiting = gate(),
      release = gate();
    const add = f.store.addTraceEvent.bind(f.store);
    vi.spyOn(f.store, "addTraceEvent").mockImplementation(async (event) => {
      await add(event);
      if (
        event.type === "execution.advance" &&
        (event.payload as { phase: string }).phase === "waiting"
      ) {
        waiting.resolve();
        await release.promise;
      }
    });
    try {
      const result = f.post().then((response) => response.text());
      await waiting.promise;
      expect(await f.status()).toMatchObject({
        state: "running",
        advance: { phase: "waiting", round: 1, limit: 3 },
      });
      await f.stop();
      await f.stop();
      release.resolve();
      const stream = events(await result);
      expect(f.calls()).toBe(1);
      expect(
        stream.filter((event) => event.type === "execution.started"),
      ).toHaveLength(1);
      expect(
        stream.filter((event) => event.type === "execution.round.completed"),
      ).toHaveLength(1);
      expect(
        stream.filter((event) => event.type === "execution.completed"),
      ).toHaveLength(1);
      expect(stream.at(-1)?.payload.committed).toBe(true);
      expect(
        stream.filter((event) => event.type === "execution.advance").at(-1)
          ?.payload.reason,
      ).toBe("player-stop");
      expect(await f.status()).toMatchObject({ state: "completed" });
      expect(await f.store.queryTurnResults(f.sessionId, {})).toHaveLength(1);
    } finally {
      release.resolve();
      await f.close();
    }
  });
  it("aborts a running generated round; its explicit retry keeps provenance and runs once", async () => {
    const running = gate();
    const f = await advanceFixture({
      onGenerate: async (index, request) => {
        if (index !== 1) return;
        running.resolve();
        await new Promise<void>((_, reject) => {
          const abort = () => reject(new DOMException("Stopped", "AbortError"));
          if (request.signal?.aborted) abort();
          else request.signal?.addEventListener("abort", abort, { once: true });
        });
      },
    });
    try {
      const result = f.post().then((response) => response.text());
      await running.promise;
      const live = await f.status();
      expect(live).toMatchObject({
        state: "running",
        advance: { phase: "running", round: 1 },
      });
      await f.stop();
      const stream = events(await result);
      expect(f.calls()).toBe(2);
      expect(
        stream.filter((event) => event.type === "execution.completed"),
      ).toHaveLength(1);
      const status = await f.status();
      expect(status).toMatchObject({
        state: "failed",
        origin: "continuation",
        retry: { type: "retry_turn", payload: {} },
      });
      const retry = events(
        await (
          await f.post({ recoverFromTurnId: status.turnId }, "retry_turn")
        ).text(),
      );
      expect(
        retry.filter((event) => event.type === "execution.started"),
      ).toHaveLength(1);
      expect(f.calls()).toBe(3);
      expect(
        (await f.store.getSession(f.sessionId))?.completedPlayerTurns,
      ).toBe(5);
      const starts = await f.store.queryTraceEvents(f.sessionId, {
        types: ["turn.started"],
      });
      const provenance = starts.map(
        (event) => (event.payload as { advancement: unknown }).advancement,
      );
      expect(provenance[1]).toEqual(provenance[2]);
      expect(provenance[2]).toMatchObject({
        logicalTurn: 5,
        kind: "advance",
        actions: [{ kind: "advance", source: "system", seatId: "human" }],
      });
    } finally {
      await f.close();
    }
  });
  it("new input cancels future rounds without aborting the ordinary root", async () => {
    const started = gate(),
      release = gate(),
      admitted = gate();
    const register = turnControl.registerActionRequest;
    let registrations = 0;
    vi.spyOn(turnControl, "registerActionRequest").mockImplementation(
      (...args) => {
        const control = register(...args);
        if (++registrations === 2) admitted.resolve();
        return control;
      },
    );
    const f = await advanceFixture({
      yields: ["continue", "user"],
      onGenerate: async (index, request) => {
        if (index !== 0) return;
        started.resolve();
        await release.promise;
        expect(request.signal?.aborted).toBe(false);
      },
    });
    try {
      const older = f.post().then((response) => response.text());
      await started.promise;
      // app.request resolves with stream headers only after admission.
      const newerResponse = await f.post({
        actions: [{ kind: "say", text: "A new arrival" }],
      });
      const newer = newerResponse.text();
      await admitted.promise;
      release.resolve();
      const first = events(await older),
        second = events(await newer);
      expect(
        first.filter((event) => event.type === "execution.advance").at(-1)
          ?.payload.reason,
      ).toBe("new-input");
      expect(
        first.filter((event) => event.type === "execution.started"),
      ).toHaveLength(1);
      expect(
        second.filter((event) => event.type === "execution.started"),
      ).toHaveLength(1);
      expect(
        (await f.store.getSession(f.sessionId))?.completedPlayerTurns,
      ).toBe(6);
    } finally {
      release.resolve();
      await f.close();
    }
  });
  it("rejected source spoofing does not invalidate an admitted chain", async () => {
    const started = gate(),
      release = gate();
    const f = await advanceFixture({
      limit: 1,
      onGenerate: async (index) => {
        if (index === 0) {
          started.resolve();
          await release.promise;
        }
      },
    });
    try {
      const result = f.post().then((response) => response.text());
      await started.promise;
      const invalid = await f.post({
        actions: [{ kind: "advance", source: "system" }],
      });
      expect(invalid.status).toBe(400);
      release.resolve();
      expect(
        events(await result).filter(
          (event) => event.type === "execution.started",
        ),
      ).toHaveLength(2);
    } finally {
      release.resolve();
      await f.close();
    }
  });
  it.each(["paused", "ended", "replaced", "deleted"])(
    "revalidates a %s session and freezes the cap at root acceptance",
    async (change) => {
      const f = await advanceFixture({ limit: 1 });
      const add = f.store.addTraceEvent.bind(f.store);
      vi.spyOn(f.store, "addTraceEvent").mockImplementation(async (event) => {
        await add(event);
        if (
          event.type === "execution.advance" &&
          (event.payload as { phase: string }).phase === "waiting"
        ) {
          const live = (await f.store.getSession(f.sessionId))!;
          if (change === "deleted") await f.store.deleteSession(f.sessionId);
          else
            await f.store.updateSession(f.sessionId, {
              ...(change === "paused" || change === "ended"
                ? { status: change }
                : {}),
              metadata: {
                ...live.metadata,
                autoAdvanceLimit: 10,
                ...(change === "replaced"
                  ? { sessionIncarnationNonce: crypto.randomUUID() }
                  : {}),
              },
            });
        }
      });
      try {
        const stream = events(await (await f.post()).text());
        expect(f.calls()).toBe(1);
        expect(
          stream.filter((event) => event.type === "execution.advance").at(-1)
            ?.payload,
        ).toMatchObject({
          reason:
            change === "deleted"
              ? "prerequisite-unavailable"
              : "session-unavailable",
          limit: 1,
        });
        expect(await f.store.queryTurnResults(f.sessionId, {})).toHaveLength(
          change === "deleted" ? 0 : 1,
        );
      } finally {
        await f.close();
      }
    },
  );
});

describe("cancellation at automatic execution boundaries", () => {
  it.each([
    ["lock acquisition", "stop"],
    ["lock acquisition", "new input"],
    ["settle wait", "stop"],
    ["settle wait", "new input"],
    ["commit transaction", "stop"],
  ])(
    "cancels during %s via %s without losing committed work",
    async (boundary, cancellation) => {
      const reached = gate(),
        release = gate(),
        held = gate();
      const lock = createInProcessSessionLock();
      let pending = false;
      let armed = false;
      let holder: Promise<void> | undefined;
      let root:
        Awaited<ReturnType<DataStore["queryTurnResults"]>>[number] | undefined;
      const settled = createSettledSessionLock({
        sessionLock: lock,
        listPendingJobs: async () =>
          pending ? [{ jobId: "earlier-settle-job" }] : [],
        wake: () => reached.resolve(),
      });
      const f = await advanceFixture({
        sessionLock: lock,
        ...(boundary === "settle wait" ? { settledSessionLock: settled } : {}),
        yields:
          boundary === "commit transaction"
            ? ["continue", "continue", "user"]
            : ["continue", "user"],
      });
      const acquire = lock.withLock.bind(lock);
      vi.spyOn(lock, "withLock").mockImplementation((sessionId, run) => {
        if (armed && boundary === "lock acquisition") {
          armed = false;
          reached.resolve();
        }
        return acquire(sessionId, run);
      });
      const add = f.store.addTraceEvent.bind(f.store);
      vi.spyOn(f.store, "addTraceEvent").mockImplementation(async (event) => {
        await add(event);
        if (
          event.type !== "execution.advance" ||
          (event.payload as { phase: string }).phase !== "waiting"
        )
          return;
        root = (
          await f.store.queryTurnResults(f.sessionId, {
            commitStatus: "committed",
          })
        )[0];
        if (boundary === "settle wait") pending = true;
        if (boundary === "lock acquisition") {
          holder = acquire(f.sessionId, async () => {
            held.resolve();
            await release.promise;
          });
          await held.promise;
          armed = true;
        }
      });
      const transaction = f.store.withTransaction.bind(f.store);
      vi.spyOn(f.store, "withTransaction").mockImplementation((run) =>
        transaction(async (tx) =>
          run(
            new Proxy(tx, {
              get(target, key, receiver) {
                if (key !== "setTurnResultCommitStatus")
                  return Reflect.get(target, key, receiver);
                return async (
                  ...args: Parameters<typeof tx.setTurnResultCommitStatus>
                ) => {
                  await tx.setTurnResultCommitStatus(...args);
                  if (
                    boundary === "commit transaction" &&
                    f.calls() === 2 &&
                    args[2] === "committed"
                  ) {
                    reached.resolve();
                    await release.promise;
                  }
                };
              },
            }),
          ),
        ),
      );
      try {
        const older = f
          .post({
            inputMessageId: "original",
            actions: [{ kind: "say", text: "Begin" }],
          })
          .then((response) => response.text());
        await Promise.race([
          reached.promise,
          older.then((text) => {
            throw new Error(`Boundary was not reached: ${text}`);
          }),
        ]);
        expect(root).toBeDefined();
        expect(turnControl.getActiveTurn(f.sessionId)).toMatchObject({
          advance: {
            phase: boundary === "commit transaction" ? "running" : "waiting",
          },
        });
        if (boundary === "commit transaction") {
          // MemoryStore queues reads behind transactions. Deliver the signal
          // directly through the same controller used by an authorized Stop.
          expect(turnControl.abortActiveTurn(f.sessionId)).not.toBeNull();
        } else if (cancellation === "stop") await f.stop();
        const submitReplacement = () =>
          f.post({
            inputMessageId: "replacement",
            actions: [{ kind: "say", text: "Change course" }],
          });
        const replacementResponse =
          boundary === "commit transaction"
            ? older.then(submitReplacement)
            : submitReplacement();
        const replacement = replacementResponse.then((response) =>
          response.text(),
        );
        if (boundary !== "commit transaction") await replacementResponse;
        // Lock and settle waits must return on cancellation, before the blocker
        // is released. A queued lock callback must never execute later.
        if (boundary !== "commit transaction") await older;
        pending = false;
        release.resolve();
        await holder;
        const oldStream = events(await older),
          newStream = events(await replacement);
        expect(
          oldStream.filter((event) => event.type === "execution.advance").at(-1)
            ?.payload.reason,
        ).toBe(cancellation === "stop" ? "player-stop" : "new-input");
        expect(
          newStream.filter((event) => event.type === "execution.started"),
        ).toHaveLength(1);
        expect(
          newStream.filter((event) => event.type === "execution.completed"),
        ).toHaveLength(1);
        expect(newStream.at(-1)?.payload.committed).toBe(true);
        expect(f.calls()).toBe(boundary === "commit transaction" ? 3 : 2);
        const rows = await f.store.queryTurnResults(f.sessionId, {});
        expect(rows.map((row) => row.commitStatus)).toEqual(
          boundary === "commit transaction"
            ? ["committed", "failed", "committed"]
            : ["committed", "committed"],
        );
        expect(rows[0]).toEqual(root);
        expect(
          (await f.store.listMessages(f.sessionId))
            .filter((message) => message.role === "user")
            .map((message) => message.id),
        ).toEqual(["original", "replacement"]);
        expect(
          (await f.store.listTurnMessages(f.sessionId))
            .filter((message) => message.sourceType === "runtime")
            .map((message) => message.content),
        ).toEqual([
          "Story 1.",
          boundary === "commit transaction" ? "Story 3." : "Story 2.",
        ]);
        expect(
          await f.store.listPluginData(f.sessionId, "observer", "rounds"),
        ).toHaveLength(2);
        expect(
          (await f.store.getSession(f.sessionId))?.completedPlayerTurns,
        ).toBe(6);
        expect(await f.status()).toMatchObject({ state: "completed" });
      } finally {
        pending = false;
        release.resolve();
        await holder;
        await f.close();
      }
    },
  );
});

it.each(["retry_runtime", "retry_failed_runtimes"])(
  "%s of an automatic source retains its system action, clock and operations without advancing",
  async (type) => {
    const f = await advanceFixture({
      limit: 1,
      onGenerate: async (index) => ({
        content:
          index % 2 === 0
            ? null
            : JSON.stringify({
                segments: [{ kind: "narration", text: `Story ${index}.` }],
                yield: "continue",
              }),
        toolCalls:
          index % 2 === 0
            ? [
                {
                  id: `change-${index}`,
                  name: "change",
                  arguments: JSON.stringify({
                    key: index === 0 ? "root" : "automatic",
                  }),
                },
              ]
            : [],
        finishReason: index % 2 === 0 ? "tool_calls" : "stop",
        usage: { inputTokens: 1, outputTokens: 1 },
      }),
      prepare: async (builtin, store, sessionId) => {
        await writeFile(
          join(builtin, "story", "PLUGIN.md"),
          `---
id: story
description: A story with an operation
runtime:
  schedule: { stage: narrative }
  io: { visibility: story, output: { contract: narrative-engine@2 } }
  agent:
    tools:
      services: [{ contract: change@1, as: change }]
---
Tell a short story.
`,
        );
        await mkdir(join(builtin, "provider"));
        await writeFile(
          join(builtin, "provider", "PLUGIN.md"),
          `---
id: provider
description: Records a change
entry: ./entry.mjs
contributes:
  services: [{ contract: change@1, access: write, modelFacing: true }]
---
`,
        );
        await writeFile(
          join(builtin, "provider", "entry.mjs"),
          `export default function(api) {
  const z = api.toolkit.z;
  api.registerService({ name: "change", contract: "change@1", access: "write", modelFacing: true, description: "Record a change", input: z.object({key:z.string()}), output: z.unknown(), handler: async ({key},ctx) => { await ctx.pluginData.set("values",key,true); return {key}; } });
}`,
        );
        await writeFile(
          join(builtin, "observer", "PLUGIN.md"),
          `---
id: observer
description: Records retry context
runtime:
  schedule: { stage: post-turn }
  io:
    inputs:
      operations: { from: { kernel: operations@1 } }
  function: { handler: ./handler.mjs }
---
`,
        );
        await writeFile(
          join(builtin, "observer", "handler.mjs"),
          `let calls=0;
export default async function(ctx) {
  if (++calls === 2) throw new Error("Observer unavailable");
  return { outcome:"success", value:{}, effects:{pluginData:[{namespace:"rounds",key:ctx.turnId,value:{logicalTurn:ctx.logicalTurn,actions:ctx.playerActions,operations:ctx.inputs.operations.value}}]} };
}`,
        );
        await store.updateSession(sessionId, {
          activePlugins: ["story", "observer", "provider"],
        });
      },
    });
    try {
      const initial = events(await (await f.post()).text());
      expect(
        initial.filter((event) => event.type === "execution.started"),
      ).toHaveLength(2);
      const rows = await f.store.queryTurnResults(f.sessionId, {});
      expect(rows.map((row) => row.commitStatus)).toEqual([
        "committed",
        "committed",
      ]);
      const source = rows[1]!;
      expect(source.runtimeResults).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ runtimeId: "observer", status: "failed" }),
        ]),
      );
      const sourceStarts = await f.store.queryTraceEvents(f.sessionId, {
        turnId: source.turnId,
        types: ["turn.started"],
      });
      const provenance = (sourceStarts[0]!.payload as { advancement: unknown })
        .advancement;
      const retry = events(
        await (
          await f.post(
            {
              retryFromTurnId: source.turnId,
              ...(type === "retry_runtime"
                ? { runtimeId: "observer" }
                : { runtimeIds: ["observer"] }),
            },
            type,
          )
        ).text(),
      );
      expect(
        retry.filter((event) => event.type === "execution.started"),
      ).toHaveLength(1);
      expect(
        retry
          .filter((event) => event.type === "runtime.started")
          .map((event) => event.payload.runtimeId),
      ).toEqual(["observer"]);
      expect(
        retry.filter(
          (event) =>
            event.type === "execution.advance" &&
            event.payload.phase !== "stopped",
        ),
      ).toEqual([]);
      expect(retry.at(-1)?.payload).toMatchObject({
        committed: true,
        sourceTurnId: source.turnId,
      });
      expect(f.calls()).toBe(4);
      const attempts = await f.store.queryTurnResults(f.sessionId, {});
      expect(attempts).toHaveLength(3);
      expect(attempts[2]).toMatchObject({
        origin: "manual",
        commitStatus: "committed",
        retryScope: { sourceTurnId: source.turnId, runtimeIds: ["observer"] },
      });
      const retryStarts = await f.store.queryTraceEvents(f.sessionId, {
        turnId: attempts[2]!.turnId,
        types: ["turn.started"],
      });
      expect(
        (retryStarts[0]!.payload as { advancement: unknown }).advancement,
      ).toEqual(provenance);
      const observed = (
        await f.store.getPluginData(
          f.sessionId,
          "observer",
          "rounds",
          attempts[2]!.turnId,
        )
      )?.value;
      expect(observed).toMatchObject({
        logicalTurn: 5,
        actions: [{ kind: "advance", source: "system", seatId: "human" }],
        operations: {
          operations: [
            {
              contract: "change@1",
              request: { key: "automatic" },
              result: { key: "automatic" },
            },
          ],
        },
      });
      expect(
        (await f.store.listPluginData(f.sessionId, "provider", "values"))
          .map((row) => row.key)
          .sort(),
      ).toEqual(["automatic", "root"]);
      expect(
        (await f.store.getSession(f.sessionId))?.completedPlayerTurns,
      ).toBe(5);
      expect((await f.status()).state).toBe("completed");
    } finally {
      await f.close();
    }
  },
);
