import { describe, expect, it, vi } from "vitest";
import { createHookPipeline } from "@covel/runtime";
import {
  apiListResponseSchema,
  pluginSummarySchema,
  type Proposal,
} from "@covel/shared";
import { presentationFixture } from "../helpers/presentation-runtime-fixture.js";
import { createSqliteStore } from "@covel/store/sqlite";
import {
  exportSessionCheckpoint,
  replaceSessionFromCheckpoint,
} from "@covel/store";
import { enqueueDeferredRuntimeJobs } from "../../src/routes/api/plugin-rpc/runtime-job-enqueue.js";
import { createPresentationBrowserFixture } from "../helpers/presentation-browser.js";
import { parseStagedRuntimeJobPayload } from "../../src/routes/api/plugin-rpc/runtime-job-worker.js";
import { publicRuntimeJob } from "../../src/routes/api/plugin-rpc/runtime-job-public.js";
import { createRuntimeJob } from "../../src/routes/api/plugin-rpc/jobs.js";

async function action(
  f: Awaited<ReturnType<typeof createPresentationBrowserFixture>>,
  type = "submit_actions",
  payload: Record<string, unknown> = {
    actions: [{ kind: "say", text: "Visit the library" }],
  },
) {
  const response = await f.app.request("/api/actions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      requestId: crypto.randomUUID(),
      sessionId: f.sessionId,
      type,
      payload,
    }),
  });
  expect(response.ok, await response.clone().text()).toBe(true);
  return response.text();
}

describe("durable public presentation", () => {
  it("preserves story and independent auxiliary writes when the presentation queue is full", async () => {
    const f = await presentationFixture({
      ready: () => false,
      auxiliaryHandler: async (ctx) => {
        await ctx.pluginData!.set("state", "current", { saved: true });
        return { outcome: "success", value: {} };
      },
    });
    try {
      f.manifests.push({
        ...f.story,
        name: "auxiliary",
        pluginId: "auxiliary",
        outputKind: "system",
        outputContract: undefined,
        effects: { writes: ["plugin-data:self:state"] },
      });
      await f.store.withTransaction(async (tx) => {
        for (let i = 0; i < 256; i++)
          await createRuntimeJob(tx, {
            sessionId: f.sessionId,
            jobId: `queued-${i}`,
            pluginId: "waiting",
            runtimeId: "waiting/render",
            origin: { activation: "stage", sourceTurnId: `waiting-${i}` },
            payload: {},
          });
      });
      expect((await f.source()).outcome.status).toBe("committed");
      expect(await f.store.listMessages(f.sessionId)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ content: "Public library story" }),
        ]),
      );
      expect(await f.jobs()).toHaveLength(256);
      expect(
        (
          await f.store.getPluginData(
            f.sessionId,
            "auxiliary",
            "state",
            "current",
          )
        )?.value,
      ).toEqual({ saved: true });
      const terminal = (await f.store.listTraceEvents(f.sessionId)).filter(
        (event) => event.type === "presentation.completed",
      );
      expect(terminal).toHaveLength(1);
      expect(terminal[0]?.payload).toMatchObject({
        runtimeId: f.presentation.name,
        status: "no-op",
        reason: "unavailable",
        budget: { calls: { used: 0 } },
      });
    } finally {
      await f.close();
    }
  });

  it.each(["scene-stage", "soundtrack"])(
    "recovers a failed inline %s selector through the action endpoint",
    async (pluginId) => {
      const f = await createPresentationBrowserFixture("updated", {
        failInline: true,
      });
      try {
        expect(await action(f)).toContain('"committed":true');
        const [source] = await f.store.queryTurnResults(f.sessionId, {
          origins: ["player"],
          commitStatus: "committed",
        });
        expect(source).toBeDefined();
        expect(source!.runtimeResults).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              runtimeId: `${pluginId}/story-cues`,
              status: "failed",
            }),
          ]),
        );
        expect(
          (await f.store.listTraceEvents(f.sessionId))
            .filter((event) => event.type === "presentation.completed")
            .map((event) => event.payload),
        ).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              runtimeId: `${pluginId}/story-cues`,
              runId: expect.any(String),
            }),
          ]),
        );
        expect(
          await action(f, "retry_runtime", {
            runtimeId: `${pluginId}/story-cues`,
            retryFromTurnId: source!.turnId,
          }),
        ).toContain('"committed":true');
        const attempts = await f.store.queryTurnResults(f.sessionId, {
          origins: ["manual"],
          commitStatus: "committed",
        });
        expect(attempts).toHaveLength(1);
        expect(attempts[0]?.runtimeResults).toEqual([
          expect.objectContaining({
            runtimeId: `${pluginId}/story-cues`,
            status: "success",
          }),
        ]);
        expect(
          (await f.store.getSession(f.sessionId))?.completedPlayerTurns,
        ).toBe(1);
        const completion = (await f.store.listTraceEvents(f.sessionId)).find(
          (event) =>
            event.type === "turn.completed" &&
            event.turnId === attempts[0]!.turnId,
        );
        expect(completion?.payload).toMatchObject({
          sourceTurnId: source!.turnId,
          sourceFailedRuntimeIds: [
            `${pluginId === "scene-stage" ? "soundtrack" : "scene-stage"}/story-cues`,
          ],
        });
        expect(
          (
            await f.store.getPluginData(
              f.sessionId,
              pluginId,
              pluginId === "scene-stage" ? "stage" : "state",
              pluginId === "scene-stage" ? "current" : "mood",
            )
          )?.value,
        ).toMatchObject(
          pluginId === "scene-stage"
            ? { sceneId: "library" }
            : { mood: "Tense" },
        );
        const terminal = (await f.store.listTraceEvents(f.sessionId)).filter(
          (event) =>
            event.type === "presentation.completed" &&
            (event.payload as { runtimeId: string }).runtimeId ===
              `${pluginId}/story-cues`,
        );
        expect(terminal).toHaveLength(2);
        expect(terminal[1]?.payload).toMatchObject({
          sourceTurnId: source!.turnId,
          status: "updated",
        });
      } finally {
        await f.close();
      }
    },
  );

  it("assigns separate allowances to the opening, auto-advance rounds and first player input", async () => {
    const f = await createPresentationBrowserFixture("updated", {
      yields: ["continue", "continue", "user", "user"],
      autoAdvanceLimit: 2,
    });
    try {
      await f.store.updateSession(f.sessionId, {
        phase: "setup",
        completedPlayerTurns: 0,
      });
      expect(await action(f, "start_session", {})).toContain(
        '"committed":true',
      );
      expect(
        (await f.store.getSession(f.sessionId))?.completedPlayerTurns,
      ).toBe(0);
      const openingJobs = await f.jobs();
      expect(openingJobs).toHaveLength(3);
      const sources = openingJobs.map(
        (job) => parseStagedRuntimeJobPayload(job.payload)!.descriptor,
      );
      expect(sources.every((source) => source.sourceLogicalTurn === 1)).toBe(
        true,
      );
      expect(
        new Set(sources.map((source) => source.sourceLogicalTurnId)).size,
      ).toBe(1);
      expect(new Set(sources.map((source) => source.sourceTurnId)).size).toBe(
        3,
      );
      expect(await action(f)).toContain('"committed":true');
      expect(
        (await f.store.getSession(f.sessionId))?.completedPlayerTurns,
      ).toBe(1);
      const jobs = await f.jobs();
      expect(jobs).toHaveLength(4);
      const player = parseStagedRuntimeJobPayload(
        jobs.at(-1)!.payload,
      )!.descriptor;
      expect(player.sourceLogicalTurn).toBe(1);
      expect(player.sourceLogicalTurnId).not.toBe(
        sources[0]!.sourceLogicalTurnId,
      );
      f.release();
      await vi.waitFor(async () =>
        expect(
          (await f.jobs()).every((job) => job.status === "succeeded"),
        ).toBe(true),
      );
      expect(f.mediaCalls).toHaveLength(4);
      const allowances = await f.store.listPluginData(
        f.sessionId,
        "__kernel:presentation",
        "_presentation_budget",
      );
      expect(allowances).toHaveLength(4);
      for (const row of allowances)
        expect(row.value).toMatchObject({ used: { calls: 1, generations: 0 } });
    } finally {
      await f.close();
    }
  });

  it("shares the remaining allowance across scoped paid retry and explicit job retry endpoints", async () => {
    const f = await createPresentationBrowserFixture("failed", {
      budgetCalls: 2,
    });
    try {
      await action(f);
      f.release();
      await vi.waitFor(async () =>
        expect((await f.jobs())[0]?.status).toBe("failed"),
      );
      const original = (await f.jobs())[0]!;
      const baseline = parseStagedRuntimeJobPayload(
        original.payload,
      )!.descriptor;
      expect(f.mediaCalls).toHaveLength(1);
      await action(f, "retry_runtime", {
        runtimeId: original.runtimeId,
        retryFromTurnId: baseline.sourceTurnId,
      });
      await vi.waitFor(async () =>
        expect((await f.jobs()).at(-1)?.status).toBe("failed"),
      );
      expect(f.mediaCalls).toHaveLength(2);
      const second = (await f.jobs()).at(-1)!;
      const response = await f.app.request(
        `/api/sessions/${f.sessionId}/runtime-jobs/${second.jobId}/retry`,
        { method: "POST" },
      );
      expect(response.ok, await response.clone().text()).toBe(true);
      await vi.waitFor(async () =>
        expect((await f.jobs()).at(-1)?.status).toBe("succeeded"),
      );
      expect(f.mediaCalls).toHaveLength(2);
      const jobs = await f.jobs();
      expect(jobs).toHaveLength(3);
      for (const job of jobs) {
        const descriptor = parseStagedRuntimeJobPayload(
          job.payload,
        )!.descriptor;
        expect(descriptor.sourceTurnId).toBe(baseline.sourceTurnId);
        expect(descriptor.sourceExecutionId).toBe(baseline.sourceExecutionId);
        expect(descriptor.presentation).toEqual(baseline.presentation);
      }
      const allowances = await f.store.listPluginData(
        f.sessionId,
        "__kernel:presentation",
        "_presentation_budget",
      );
      expect(allowances).toHaveLength(1);
      expect(allowances[0]?.value).toMatchObject({
        used: { calls: 2, generations: 0 },
      });
      const terminal = (await f.store.listTraceEvents(f.sessionId)).filter(
        (event) =>
          event.type === "presentation.completed" &&
          (event.payload as { runtimeId: string }).runtimeId ===
            original.runtimeId,
      );
      expect(terminal.map((event) => event.payload)).toEqual([
        expect.objectContaining({
          budget: {
            calls: { limit: 2, used: 1 },
            generations: { limit: 0, used: 0 },
          },
        }),
        expect.objectContaining({
          budget: {
            calls: { limit: 2, used: 2 },
            generations: { limit: 0, used: 0 },
          },
        }),
        expect.objectContaining({
          status: "no-op",
          reason: "budget-exhausted",
          budget: {
            calls: { limit: 2, used: 2 },
            generations: { limit: 0, used: 0 },
          },
        }),
      ]);
    } finally {
      await f.close();
    }
  });
  it("parses real presentation descriptors through the strict public discovery contract", async () => {
    const f = await createPresentationBrowserFixture();
    try {
      const response = await f.app.request("/api/plugins");
      expect(response.status).toBe(200);
      const body: unknown = await response.json();
      const parsed = apiListResponseSchema(pluginSummarySchema).parse(body);
      expect(parsed).toEqual(body);
      for (const pluginId of ["scene-stage", "soundtrack"]) {
        const plugin = parsed.items.find((item) => item.id === pluginId);
        expect(plugin).toBeDefined();
        const presenter = plugin!.runtimes.find(
          (runtime) => runtime.id === `${pluginId}/story-cues`,
        );
        expect(presenter?.presentation).toEqual({
          budget: { calls: 0, generations: 0 },
        });
        expect(
          plugin!.runtimes
            .filter((runtime) => runtime.id !== presenter?.id)
            .every((runtime) => runtime.presentation === undefined),
        ).toBe(true);
      }
      const generating = parsed.items.find(
        (item) => item.id === "presentation-probe",
      );
      expect(generating?.runtimes[0]?.presentation).toEqual({
        budget: { calls: 1, generations: 0 },
      });
      expect(JSON.stringify(parsed)).not.toMatch(
        /publicAssetNamespaces|_presentation_budget|sourceTurnId|sourceExecutionId/,
      );
    } finally {
      await f.close();
    }
  });
  it("does not revive source work when a checkpoint is hydrated into a new session incarnation", async () => {
    const f = await presentationFixture();
    try {
      const source = await f.source();
      f.worker.wake();
      await vi.waitFor(() => expect(f.calls).toHaveLength(1));
      await f.worker.close();
      const checkpoint = await exportSessionCheckpoint(f.store, f.sessionId, {
        actionId: "checkpoint",
        revision: 1,
      });
      expect(
        checkpoint.pluginData.some(
          (row) => row.namespace === "_presentation_budget",
        ),
      ).toBe(false);
      const session = {
        ...f.session,
        metadata: {
          ...f.session.metadata,
          sessionIncarnationNonce: crypto.randomUUID(),
        },
      };
      await replaceSessionFromCheckpoint(f.store, checkpoint, { session });
      expect(
        await f.store.listPluginData(
          f.sessionId,
          "__kernel:presentation",
          "_presentation_budget",
        ),
      ).toEqual([]);
      const retry = await f.store.withTransaction((tx) =>
        enqueueDeferredRuntimeJobs(tx, {
          sessionId: f.sessionId,
          session,
          activeRuntimes: f.manifests,
          locale: "en-US",
          descriptors: source.descriptors.map((job) => ({
            ...job,
            jobId: crypto.randomUUID(),
          })),
        }),
      );
      expect(retry).toEqual([]);
      await f.restart();
      await vi.waitFor(async () =>
        expect((await f.jobs())[0]?.status).toBe("stale"),
      );
      expect(f.calls).toHaveLength(1);
    } finally {
      await f.close();
    }
  });
  it.each(["exhausted", "failed"] as const)(
    "keeps browser-fixture story commits when the presenter is %s",
    async (mode) => {
      const f = await createPresentationBrowserFixture(mode);
      try {
        const response = await f.app.request("/api/actions", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            requestId: crypto.randomUUID(),
            sessionId: f.sessionId,
            type: "submit_actions",
            payload: { actions: [{ kind: "say", text: "Visit the library" }] },
          }),
        });
        expect(response.ok, await response.clone().text()).toBe(true);
        expect(await response.text()).toContain('"committed":true');
        await vi.waitFor(() => expect(f.mediaCalls).toHaveLength(1));
        expect(
          (await f.store.listMessages(f.sessionId)).some((message) =>
            message.content.includes("Public library story 1."),
          ),
        ).toBe(true);
        f.release();
        await vi.waitFor(async () =>
          expect((await f.jobs())[0]?.status).toBe(
            mode === "failed" ? "failed" : "succeeded",
          ),
        );
        expect(f.mediaCalls).toHaveLength(1);
        expect(
          await f.store.getPluginData(
            f.sessionId,
            "presentation-probe",
            "display",
            "current",
          ),
        ).toBeNull();
        expect(
          (await f.store.listTraceEvents(f.sessionId)).find(
            (event) =>
              event.type === "presentation.completed" &&
              (event.payload as { pluginId?: string }).pluginId ===
                "presentation-probe",
          )?.payload,
        ).toMatchObject({
          status: mode === "failed" ? "failed" : "no-op",
          reason: mode === "failed" ? "failed" : "budget-exhausted",
          budget: { calls: { limit: 1, used: 1 } },
        });
      } finally {
        await f.close();
      }
    },
  );
  it("records a terminal reason when credential readiness expires in the queue", async () => {
    const ready = vi.fn(() => false);
    const f = await presentationFixture({ queueMs: 1_000, ready });
    vi.useFakeTimers();
    try {
      expect((await f.source()).outcome.status).toBe("committed");
      f.worker.wake();
      await vi.advanceTimersByTimeAsync(1);
      expect(ready).toHaveBeenCalled();
      expect((await f.jobs())[0]).toMatchObject({
        status: "queued",
        attempt: 0,
      });
      expect(f.calls).toHaveLength(0);

      // The first scan precedes expiry; the next maintenance pass expires
      // queued work even when credential readiness still refuses execution.
      await vi.advanceTimersByTimeAsync(30_000);
      const job = (await f.jobs())[0]!;
      expect(job).toMatchObject({
        status: "timed_out",
        reason: "queue-deadline-exceeded",
        attempt: 0,
      });
      expect(f.calls).toHaveLength(0);
      const publicJob = publicRuntimeJob(job);
      const publicReason = "Runtime job timed out while waiting to execute.";
      expect(publicJob).toMatchObject({
        status: "timed_out",
        reason: "queue-deadline-exceeded",
        error: publicReason,
      });
      expect(publicJob).not.toHaveProperty("payload");
      const status = (
        await f.store.listJobStatus(f.sessionId, { jobId: job.jobId })
      ).at(-1);
      expect(status).toMatchObject({
        state: "failed",
        message: publicReason,
        data: {
          durableStatus: "timed_out",
          reason: "queue-deadline-exceeded",
          error: publicReason,
        },
      });
      const terminal = (await f.store.listTraceEvents(f.sessionId)).filter(
        (row) => row.type === "presentation.completed",
      );
      expect(terminal).toHaveLength(1);
      expect(terminal[0]?.payload).toMatchObject({
        jobId: job.jobId,
        status: "no-op",
        reason: "unavailable",
        budget: { calls: { limit: 2, used: 0 } },
      });
      expect(JSON.stringify({ publicJob, status, terminal })).not.toMatch(
        /request-secret|raw-source-secret|private-player-intent|Public library story/,
      );
    } finally {
      try {
        await f.close();
      } finally {
        vi.useRealTimers();
      }
    }
  });
  it("settles an exhausted worker as a normal no-op without partial display writes", async () => {
    const f = await presentationFixture({
      handler: async (ctx) => {
        await ctx.pluginData!.set("display", "partial", true);
        for (const prompt of ["one", "two", "three"])
          await ctx.gateway!.generateText({ prompt });
        return { outcome: "success", value: {} };
      },
    });
    try {
      expect((await f.source()).outcome.status).toBe("committed");
      f.worker.wake();
      await vi.waitFor(() => expect(f.calls).toHaveLength(1));
      f.release();
      await vi.waitFor(async () =>
        expect((await f.jobs())[0]?.status).toBe("succeeded"),
      );
      expect(f.calls).toHaveLength(2);
      expect(
        await f.store.listPluginData(
          f.sessionId,
          f.presentation.pluginId,
          "display",
        ),
      ).toEqual([]);
      expect(
        (await f.store.listTraceEvents(f.sessionId)).find(
          (trace) => trace.type === "presentation.completed",
        )?.payload,
      ).toMatchObject({
        status: "no-op",
        reason: "budget-exhausted",
        budget: { calls: { used: 2 } },
      });
      expect(
        await f.store.queryTurnResults(f.sessionId, {
          commitStatus: "pending",
        }),
      ).toHaveLength(0);
    } finally {
      await f.close();
    }
  });
  it("refuses an oversized committed snapshot without failing its story", async () => {
    const f = await presentationFixture();
    try {
      const now = new Date().toISOString();
      await f.store.setPluginData({
        id: "large",
        sessionId: f.sessionId,
        pluginId: f.presentation.pluginId,
        namespace: "art",
        key: "large",
        value: "x".repeat(256 * 1024),
        createdAt: now,
        updatedAt: now,
      });
      expect((await f.source()).outcome.status).toBe("committed");
      expect(await f.jobs()).toHaveLength(0);
      expect(f.calls).toHaveLength(0);
      expect(
        (await f.store.listTraceEvents(f.sessionId)).find(
          (trace) => trace.type === "presentation.completed",
        )?.payload,
      ).toMatchObject({ status: "no-op", reason: "unavailable" });
    } finally {
      await f.close();
    }
  });
  it("boots the real browser fixture and commits an action before generation completes", async () => {
    const f = await createPresentationBrowserFixture();
    try {
      const response = await f.app.request("/api/actions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          requestId: crypto.randomUUID(),
          sessionId: f.sessionId,
          type: "submit_actions",
          payload: { actions: [{ kind: "say", text: "Enter the library" }] },
        }),
      });
      expect(response.ok, await response.clone().text()).toBe(true);
      const stream = await response.text();
      expect(stream).toContain('"committed":true');
      await vi.waitFor(() => expect(f.mediaCalls).toHaveLength(1));
      expect(
        (
          await f.store.getPluginData(
            f.sessionId,
            "scene-stage",
            "stage",
            "current",
          )
        )?.value,
      ).toMatchObject({ sceneId: "library" });
      expect(
        (
          await f.store.getPluginData(
            f.sessionId,
            "soundtrack",
            "state",
            "mood",
          )
        )?.value,
      ).toMatchObject({ mood: "Tense" });
      f.release();
      await vi.waitFor(async () =>
        expect((await f.jobs())[0]?.status).toBe("succeeded"),
      );
    } finally {
      await f.close();
    }
  });
  it.each([false, true])(
    "commits two source turns while generation waits and rejects an old display at commit (sqlite=%s)",
    async (sqlite) => {
      const store = sqlite ? createSqliteStore(":memory:") : undefined;
      const f = await presentationFixture({ store });
      try {
        const first = await f.source();
        expect(first.outcome.status).toBe("committed");
        expect(first.descriptors).toHaveLength(1);
        expect(JSON.stringify(first.descriptors)).not.toMatch(
          /raw-source-secret|private-player-intent|request-secret/,
        );
        f.worker.wake();
        await vi.waitFor(() => expect(f.calls).toHaveLength(1));
        expect(
          (await f.store.listMessages(f.sessionId)).some((message) =>
            message.content.includes("Public library story"),
          ),
        ).toBe(true);
        const second = await f.source();
        expect(second.outcome.status).toBe("committed");
        const now = new Date().toISOString();
        await f.lock.withLock(f.sessionId, () =>
          f.store.setPluginData({
            id: crypto.randomUUID(),
            sessionId: f.sessionId,
            pluginId: f.presentation.pluginId,
            namespace: "display",
            key: "current",
            value: { title: "Explicit newer display" },
            createdAt: now,
            updatedAt: now,
          }),
        );
        f.release();
        await vi.waitFor(async () =>
          expect(
            (await f.jobs()).every((job) => job.status === "succeeded"),
          ).toBe(true),
        );
        expect(
          (
            await f.store.getPluginData(
              f.sessionId,
              f.presentation.pluginId,
              "display",
              "current",
            )
          )?.value,
        ).toEqual({ title: "Explicit newer display" });
        expect(
          await f.store.queryTurnResults(f.sessionId, {
            commitStatus: "pending",
          }),
        ).toHaveLength(0);
        expect(
          (await f.store.listTraceEvents(f.sessionId))
            .filter((trace) => trace.type === "presentation.completed")
            .map((trace) => trace.payload),
        ).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ reason: "superseded", status: "no-op" }),
          ]),
        );
      } finally {
        await f.close();
        await store?.close();
      }
    },
  );
  it("freezes the final hook-rewritten story and parses only safe descriptors", async () => {
    const hooks = createHookPipeline();
    hooks.register<{ proposal: Proposal }>({
      id: "rewrite",
      pluginId: "public-story",
      event: "PreStateCommit",
      handler: async (_ctx, { proposal }) =>
        proposal.type === "narrative.append"
          ? {
              action: "continue",
              replace: {
                proposal: {
                  ...proposal,
                  payload: {
                    ...proposal.payload,
                    content: "Rewritten public story",
                    segments: [
                      {
                        kind: "dialogue" as const,
                        speaker: "Mira",
                        text: "Rewritten public story",
                      },
                    ],
                  },
                },
              },
            }
          : { action: "continue" },
    });
    const f = await presentationFixture({
      hooks,
      handler: async (ctx) => {
        expect(ctx.locale).toBe("en-US");
        expect(ctx.presentation?.characters).toEqual([
          { id: "mira", name: "Mira", aliases: ["M"] },
        ]);
        const art = (await ctx.pluginData!.get("art", "library")) as {
          label: string;
        };
        expect(art).toEqual({ label: "Source library art" });
        const source = ctx.inputs?.story;
        await ctx.gateway!.generateText({
          prompt: JSON.stringify(
            source?.cardinality === "one" ? source.value : null,
          ),
        });
        await ctx.pluginData!.set("display", "current", { title: art.label });
        return { outcome: "success", value: {} };
      },
    });
    try {
      const now = new Date().toISOString();
      await f.store.upsertCharacter({
        id: "mira",
        sessionId: f.sessionId,
        name: "Mira",
        aliases: ["M"],
        type: "npc",
        fields: { secret: "private-character" },
        version: 1,
        createdAt: now,
        updatedAt: now,
      });
      const asset = {
        id: "source-art",
        sessionId: f.sessionId,
        pluginId: f.presentation.pluginId,
        namespace: "art",
        key: "library",
        value: { label: "Source library art" },
        createdAt: now,
        updatedAt: now,
      };
      await f.store.setPluginData(asset);
      const result = await f.source();
      expect(result.outcome).toMatchObject({ status: "committed" });
      expect(result.descriptors[0]?.presentation?.story?.segments).toEqual([
        { kind: "dialogue", speaker: "Mira", text: "Rewritten public story" },
      ]);
      const job = (await f.jobs())[0]!;
      const valid = parseStagedRuntimeJobPayload(job.payload)!;
      expect(valid).toBeDefined();
      expect(
        parseStagedRuntimeJobPayload({
          ...valid,
          descriptor: {
            ...valid.descriptor,
            turnDigest: {
              ...valid.descriptor.turnDigest,
              playerMessage: "private",
            },
          },
        }),
      ).toBeUndefined();
      expect(
        parseStagedRuntimeJobPayload({
          ...valid,
          descriptor: {
            ...valid.descriptor,
            presentation: {
              ...valid.descriptor.presentation,
              extra: "private",
            },
          },
        }),
      ).toBeUndefined();
      await f.store.updateSession(f.sessionId, { locale: "zh-CN" });
      await f.store.setPluginData({
        ...asset,
        value: { label: "New library art" },
      });
      await f.store.upsertCharacter({
        id: "mira",
        sessionId: f.sessionId,
        name: "New Mira",
        type: "npc",
        fields: {},
        version: 2,
        createdAt: now,
        updatedAt: now,
      });
      f.worker.wake();
      await vi.waitFor(() => expect(f.calls).toHaveLength(1));
      expect(f.calls[0]).toContain("Rewritten public story");
      expect(f.calls[0]).not.toContain("Public library story");
      f.release();
      await vi.waitFor(async () =>
        expect((await f.jobs())[0]?.status).toBe("succeeded"),
      );
      expect(
        (
          await f.store.getPluginData(
            f.sessionId,
            f.presentation.pluginId,
            "display",
            "current",
          )
        )?.value,
      ).toEqual({ title: "Source library art" });
    } finally {
      await f.close();
    }
  });
  it("skips generating presenters with foreground consumers without invoking them inline", async () => {
    const handler = vi.fn(async () => ({
      outcome: "success" as const,
      value: {},
    }));
    const f = await presentationFixture({ handler });
    try {
      f.manifests.push({
        ...f.presentation,
        name: "public-display/consumer",
        presentation: undefined,
        turnCompletion: undefined,
        after: [f.presentation.name],
        inputs: undefined,
        effects: { writes: [] },
      });
      const source = await f.source();
      expect(source.outcome.status).toBe("committed");
      expect(handler).not.toHaveBeenCalled();
      expect(f.calls).toHaveLength(0);
      expect(await f.jobs()).toHaveLength(0);
      expect(
        (await f.store.listTraceEvents(f.sessionId)).find(
          (row) => row.type === "presentation.completed",
        )?.payload,
      ).toMatchObject({ status: "no-op", reason: "unavailable" });
    } finally {
      await f.close();
    }
  });
  it.each(["version", "declaration"] as const)(
    "rechecks a queued %s and records unavailable without spending",
    async (change) => {
      const f = await presentationFixture();
      try {
        await f.source();
        const entry = f.registry.get(f.presentation.pluginId)!;
        f.registry.register({
          ...entry,
          manifests: (entry.manifests ?? []).map((runtime) => ({
            ...runtime,
            manifest:
              change === "version"
                ? { ...runtime.manifest, version: "2.0.0" }
                : { ...runtime.manifest, presentation: undefined },
          })),
        });
        f.worker.wake();
        await vi.waitFor(async () =>
          expect((await f.jobs())[0]?.status).toBe("stale"),
        );
        expect(f.calls).toHaveLength(0);
        expect(
          (await f.store.listTraceEvents(f.sessionId)).find(
            (row) => row.type === "presentation.completed",
          )?.payload,
        ).toMatchObject({ reason: "unavailable" });
      } finally {
        await f.close();
      }
    },
  );
  it("retains the source allowance through graceful worker requeue", async () => {
    const f = await presentationFixture();
    try {
      await f.source();
      f.worker.wake();
      await vi.waitFor(() => expect(f.calls).toHaveLength(1));
      await f.restart();
      await vi.waitFor(() => expect(f.calls).toHaveLength(2));
      f.release();
      await vi.waitFor(async () =>
        expect((await f.jobs())[0]?.status).toBe("succeeded"),
      );
      expect(f.calls).toHaveLength(2);
      expect(
        (
          await f.store.listPluginData(
            f.sessionId,
            "__kernel:presentation",
            "_presentation_budget",
          )
        ).map((row) => row.value),
      ).toEqual([
        expect.objectContaining({ used: { calls: 2, generations: 0 } }),
      ]);
    } finally {
      await f.close();
    }
  });
  it("does not enqueue generation when the source story is rejected", async () => {
    const hooks = createHookPipeline();
    hooks.register<{ proposal: Proposal }>({
      id: "reject",
      pluginId: "public-story",
      event: "PreStateCommit",
      handler: async (_ctx, { proposal }) =>
        proposal.type === "narrative.append"
          ? { action: "abort", reason: "Rejected source" }
          : { action: "continue" },
    });
    const f = await presentationFixture({ hooks });
    try {
      expect((await f.source()).outcome.status).toBe("failed");
      f.worker.wake();
      expect(await f.jobs()).toHaveLength(0);
      expect(f.calls).toHaveLength(0);
      expect(await f.store.listMessages(f.sessionId)).toHaveLength(0);
    } finally {
      await f.close();
    }
  });
});
