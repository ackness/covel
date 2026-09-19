import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Hono } from "hono";
import { createMemoryStore, type DataStore } from "@covel/store";

import {
  createRuntimeJob,
  transitionRuntimeJob,
} from "../../src/routes/api/plugin-rpc/jobs.js";
import { runtimeJobRoutes } from "../../src/routes/api/runtime-jobs.js";
import { pluginDataRoutes } from "../../src/routes/api/plugin-data.js";
import { stateRoutes } from "../../src/routes/api/state.js";

const SESSION_ID = "public-job-session";
const PLUGIN_ID = "media";
const JOB_ID = "public-job";
const PRIVATE_INPUT = "SYNTHETIC_PRIVATE_RUNTIME_INPUT";
const PRIVATE_ERROR = "Authorization: Bearer SYNTHETIC_NEVER_VALID";

describe("runtime job public projections", () => {
  let store: DataStore;
  let app: Hono;

  beforeEach(async () => {
    store = createMemoryStore();
    const now = new Date().toISOString();
    await store.createSession({
      id: SESSION_ID,
      status: "active",
      locale: "en-US",
      phase: "playing",
      completedPlayerTurns: 1,
      setupRuntimes: {},
      activePlugins: [PLUGIN_ID],
      metadata: { sessionIncarnationNonce: "synthetic-incarnation" },
      createdAt: now,
      updatedAt: now,
    });
    await createRuntimeJob(store, {
      jobId: JOB_ID,
      sessionId: SESSION_ID,
      pluginId: PLUGIN_ID,
      runtimeId: "media/leaf",
      origin: {
        activation: "stage",
        sourceTurnId: "source-turn",
        sourceExecutionId: "source-execution",
      },
      payload: {
        expectedApprovalScope: PRIVATE_INPUT,
        descriptor: { upstreamResults: [{ output: PRIVATE_INPUT }] },
        userSettings: { media: { privateNote: PRIVATE_INPUT } },
      },
    });
    app = new Hono();
    app.use("*", async (c, next) => {
      c.set("store", store);
      c.set("pluginRegistry", { get: () => ({}) });
      await next();
    });
    app.route("/api/sessions", runtimeJobRoutes);
    app.route("/api/sessions", pluginDataRoutes);
    app.route("/api/sessions", stateRoutes);
  });

  afterEach(async () => {
    await store.close();
  });

  it.each([
    "runtime-jobs",
    `plugin-data/${PLUGIN_ID}`,
    `plugin-data/${PLUGIN_ID}/_runtime_jobs`,
    `plugin-data/${PLUGIN_ID}/_runtime_jobs/${JOB_ID}`,
    "state",
  ])("keeps private job inputs and raw failures out of %s", async (path) => {
    await transitionRuntimeJob(store, {
      sessionId: SESSION_ID,
      pluginId: PLUGIN_ID,
      jobId: JOB_ID,
      from: ["queued"],
      to: "failed",
      reason: "execution-failed",
      error: PRIVATE_ERROR,
      backgroundTurnId: "background-turn",
      backgroundExecutionId: "background-execution",
    });
    const response = await app.request(`/api/sessions/${SESSION_ID}/${path}`);
    expect(response.status).toBe(200);
    const text = await response.text();
    expect(text).not.toContain(PRIVATE_INPUT);
    expect(text).not.toContain(PRIVATE_ERROR);
    expect(text).toContain("execution-failed");
    expect(text).toContain(JOB_ID);
    expect(text).toContain("source-turn");
    expect(text).toContain("source-execution");
    expect(text).toContain("background-turn");
    expect(text).toContain("background-execution");
    expect(
      await store.getPluginData(SESSION_ID, PLUGIN_ID, "_runtime_jobs", JOB_ID),
    ).toMatchObject({
      value: {
        error: PRIVATE_ERROR,
        payload: { expectedApprovalScope: PRIVATE_INPUT },
      },
    });
  });

  it("preserves an actionable queue timeout when hydrating plugin data", async () => {
    await transitionRuntimeJob(store, {
      sessionId: SESSION_ID,
      pluginId: PLUGIN_ID,
      jobId: JOB_ID,
      from: ["queued"],
      to: "timed_out",
      reason: "queue-deadline-exceeded",
    });
    const response = await app.request(
      `/api/sessions/${SESSION_ID}/plugin-data/${PLUGIN_ID}/_runtime_jobs/${JOB_ID}`,
    );
    const body = (await response.json()) as {
      value: { status: string; reason: string; error?: string };
    };
    expect(body.value).toMatchObject({
      status: "timed_out",
      reason: "queue-deadline-exceeded",
    });
    expect(body.value.error).toMatch(/timed out.*waiting/i);
  });

  it("does not expose an unrecognized reason as free text", async () => {
    await transitionRuntimeJob(store, {
      sessionId: SESSION_ID,
      pluginId: PLUGIN_ID,
      jobId: JOB_ID,
      from: ["queued"],
      to: "failed",
      reason: PRIVATE_ERROR,
      error: PRIVATE_ERROR,
    });
    const response = await app.request(
      `/api/sessions/${SESSION_ID}/runtime-jobs`,
    );
    const text = await response.text();
    expect(text).not.toContain(PRIVATE_ERROR);
    expect(JSON.parse(text).items[0].error).toMatch(/execution failed/i);
  });

  it("keeps successful game output and ordinary plugin namespaces available", async () => {
    for (const [from, to] of [
      ["queued", "claimed"],
      ["claimed", "running"],
      ["running", "committing"],
    ] as const) {
      await transitionRuntimeJob(store, {
        sessionId: SESSION_ID,
        pluginId: PLUGIN_ID,
        jobId: JOB_ID,
        from: [from],
        to,
      });
    }
    const result = {
      turnId: "background-turn",
      executionId: "background-execution",
      runtimeId: "media/leaf",
      durationMs: 12,
      output: { trackId: "track", ref: { id: "public-media" } },
    };
    await transitionRuntimeJob(store, {
      sessionId: SESSION_ID,
      pluginId: PLUGIN_ID,
      jobId: JOB_ID,
      from: ["committing"],
      to: "succeeded",
      result,
    });
    const now = new Date().toISOString();
    await store.setPluginData({
      id: "game-output",
      sessionId: SESSION_ID,
      pluginId: PLUGIN_ID,
      namespace: "tracks",
      key: "track",
      value: {
        text: "Narrative content",
        payload: "plugin-defined value",
        error: "plugin-defined field",
      },
      createdAt: now,
      updatedAt: now,
    });
    const response = await app.request(
      `/api/sessions/${SESSION_ID}/plugin-data/${PLUGIN_ID}`,
    );
    const body = (await response.json()) as {
      items: { namespace: string; value: unknown }[];
    };
    expect(
      body.items.find((row) => row.namespace === "_runtime_jobs")?.value,
    ).toMatchObject({ result });
    expect(body.items.find((row) => row.namespace === "tracks")?.value).toEqual(
      {
        text: "Narrative content",
        payload: "plugin-defined value",
        error: "plugin-defined field",
      },
    );
  });
});
