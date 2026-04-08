import { describe, expect, it, vi, beforeEach } from "vitest";
import { Hono } from "hono";
import { resolve } from "node:path";
import { createV1RuntimeRoutes } from "../src/routes/v1/runtimes.js";
import { createV1ActionRoutes } from "../src/routes/v1/actions.js";
import { createV1ApprovalRoutes } from "../src/routes/v1/approvals.js";
import { createPluginManager } from "../../../packages/plugin-manager/src/index.ts";
import { createV1KernelSession } from "@covel/kernel";

const PLUGIN_DEMO_DIR = resolve(import.meta.dirname, "../../../docs/plugin-system-v1/plugin-demo");
const IMAGE_DEMO_DIR = resolve(import.meta.dirname, "../../../docs/plugin-system-v1/image-workflow-demo");

function createMockSession() {
  return {
    executeRuntime: vi.fn(async (pluginId: string, runtimeId: string, payload?: unknown) => ({
      pluginId,
      runtimeId,
      status: "success" as const,
      payload: payload ?? null,
      record: {
        recordType: "runtime_result",
        pluginId,
        runtimeId,
        sessionId: "session-1",
        turnId: "manual-turn-1",
        runId: "run-1",
        traceId: "trace-1",
        status: "success" as const,
        timestamp: "2026-04-07T00:00:00.000Z",
        locale: "zh-CN",
        payload: payload ?? null,
      },
    })),
    listRuntimes: vi.fn(() => [
      {
        pluginId: "image-workflow-demo",
        runtimeId: "prompt-optimizer",
        priority: 710,
        trigger: { type: "manual", action: "generate-story-image" },
      },
    ]),
    getLastRecord: vi.fn((_pluginId: string, _runtimeId: string) => ({
      recordType: "runtime_result",
      pluginId: "image-workflow-demo",
      runtimeId: "image-generator",
      sessionId: "session-1",
      turnId: "manual-turn-2",
      runId: "run-2",
      traceId: "trace-2",
      status: "success" as const,
      timestamp: "2026-04-07T00:00:00.000Z",
      locale: "zh-CN",
      payload: {
        imageUrl: "https://example.com/image.png",
      },
    })),
    executeAction: vi.fn(async (pluginId: string, actionId: string, payload?: unknown) => ({
      workflowRunId: "wf-1",
      pluginId,
      actionId,
      status: "queued" as const,
      currentStep: null,
      steps: [],
      payload,
    })),
    getWorkflow: vi.fn((_workflowRunId: string) => ({
      workflowRunId: "wf-1",
      pluginId: "image-workflow-demo",
      actionId: "generate-story-image",
      status: "running" as const,
      currentStep: "prompt-optimizer",
      steps: [
        { runtimeId: "prompt-optimizer", status: "running" as const },
        { runtimeId: "image-generator", status: "queued" as const },
      ],
    })),
    handleApprovalCallback: vi.fn(async (interactionId: string, decision: "approved" | "denied", response?: unknown) => ({
      interactionId,
      decision,
      response: response ?? null,
      status: "processed" as const,
    })),
  };
}

describe("V1 route integration", () => {
  it("executes a runtime through V1KernelSession", async () => {
    const session = createMockSession();
    const app = new Hono();
    app.route(
      "/api",
      createV1RuntimeRoutes({
        getOrCreateSession: async (_sessionId: string) => session,
      }),
    );

    const res = await app.request("/api/sessions/session-1/runtimes/image-workflow-demo/prompt-optimizer/execute", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        trigger: {
          type: "manual",
          action: "generate-story-image",
          payload: { messageId: "msg-1" },
        },
      }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(session.executeRuntime).toHaveBeenCalledWith(
      "image-workflow-demo",
      "prompt-optimizer",
      { messageId: "msg-1" },
    );
    expect(body.record.runtimeId).toBe("prompt-optimizer");
  });

  it("lists available runtimes from the session", async () => {
    const session = createMockSession();
    const app = new Hono();
    app.route(
      "/api",
      createV1RuntimeRoutes({
        getOrCreateSession: async (_sessionId: string) => session,
      }),
    );

    const res = await app.request("/api/sessions/session-1/runtimes");

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(session.listRuntimes).toHaveBeenCalledOnce();
    expect(body.runtimes).toHaveLength(1);
  });

  it("returns the last record for a runtime", async () => {
    const session = createMockSession();
    const app = new Hono();
    app.route(
      "/api",
      createV1RuntimeRoutes({
        getOrCreateSession: async (_sessionId: string) => session,
      }),
    );

    const res = await app.request("/api/sessions/session-1/runtimes/image-workflow-demo/image-generator/last-record");

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(session.getLastRecord).toHaveBeenCalledWith("image-workflow-demo", "image-generator");
    expect(body.record.payload.imageUrl).toBe("https://example.com/image.png");
  });

  it("starts an action workflow through the session", async () => {
    const session = createMockSession();
    const app = new Hono();
    app.route(
      "/api",
      createV1ActionRoutes({
        getOrCreateSession: async (_sessionId: string) => session,
      }),
    );

    const res = await app.request("/api/sessions/session-1/actions/image-workflow-demo/generate-story-image/execute", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        payload: {
          messageId: "msg-1",
          style: "cinematic",
        },
      }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(session.executeAction).toHaveBeenCalledWith(
      "image-workflow-demo",
      "generate-story-image",
      { messageId: "msg-1", style: "cinematic" },
    );
    expect(body.workflowRunId).toBe("wf-1");
  });

  it("returns workflow status from the session", async () => {
    const session = createMockSession();
    const app = new Hono();
    app.route(
      "/api",
      createV1ActionRoutes({
        getOrCreateSession: async (_sessionId: string) => session,
      }),
    );

    const res = await app.request("/api/sessions/session-1/workflows/wf-1");

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(session.getWorkflow).toHaveBeenCalledWith("wf-1");
    expect(body.currentStep).toBe("prompt-optimizer");
  });

  it("processes approval callbacks through the session", async () => {
    const session = createMockSession();
    const app = new Hono();
    app.route(
      "/api",
      createV1ApprovalRoutes({
        getOrCreateSession: async (_sessionId: string) => session,
      }),
    );

    const res = await app.request("/api/sessions/session-1/approvals/callback", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        interactionId: "iact-1",
        decision: "approved",
        response: { note: "ok" },
      }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(session.handleApprovalCallback).toHaveBeenCalledWith("iact-1", "approved", { note: "ok" });
    expect(body.status).toBe("processed");
  });

  it("rejects approval callbacks without required fields", async () => {
    const session = createMockSession();
    const app = new Hono();
    app.route(
      "/api",
      createV1ApprovalRoutes({
        getOrCreateSession: async (_sessionId: string) => session,
      }),
    );

    const res = await app.request("/api/sessions/session-1/approvals/callback", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });

    expect(res.status).toBe(400);
    expect(session.handleApprovalCallback).not.toHaveBeenCalled();
  });
});

describe("V1 route integration with real V1KernelSession", () => {
  let runtimeApp: Hono;
  let actionApp: Hono;
  let approvalApp: Hono;

  beforeEach(async () => {
    const manager = createPluginManager();
    await manager.load(PLUGIN_DEMO_DIR);
    await manager.load(IMAGE_DEMO_DIR);

    const sessions = new Map<string, ReturnType<typeof createV1KernelSession>>();
    const getOrCreateSession = async (sessionId: string) => {
      const existing = sessions.get(sessionId);
      if (existing) return existing;
      const created = createV1KernelSession({ pluginManager: manager }, sessionId);
      created.state.isPreGame = false;
      sessions.set(sessionId, created);
      return created;
    };

    runtimeApp = new Hono();
    runtimeApp.route("/api", createV1RuntimeRoutes({ getOrCreateSession }));

    actionApp = new Hono();
    actionApp.route("/api", createV1ActionRoutes({ getOrCreateSession }));

    approvalApp = new Hono();
    approvalApp.route("/api", createV1ApprovalRoutes({ getOrCreateSession }));
  });

  it("executes a real runtime and exposes its last record", async () => {
    const executeRes = await runtimeApp.request(
      "/api/sessions/session-real/runtimes/demo-plugin/luck-roller/execute",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          trigger: {
            type: "manual",
            action: "roll-luck",
            payload: { messageId: "msg-1" },
          },
        }),
      },
    );

    expect(executeRes.status).toBe(200);
    const executed = await executeRes.json();
    expect(executed.record.runtimeId).toBe("luck-roller");

    const lastRes = await runtimeApp.request(
      "/api/sessions/session-real/runtimes/demo-plugin/luck-roller/last-record",
    );

    expect(lastRes.status).toBe(200);
    const last = await lastRes.json();
    expect(last.record).not.toBeNull();
    expect(last.record.runtimeId).toBe("luck-roller");
  });

  it("executes a real action workflow and exposes workflow + final runtime record", async () => {
    const actionRes = await actionApp.request(
      "/api/sessions/session-workflow/actions/image-workflow-demo/generate-story-image/execute",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          payload: {
            messageId: "msg-2",
            style: "cinematic",
          },
        }),
      },
    );

    expect(actionRes.status).toBe(200);
    const workflow = await actionRes.json();
    expect(workflow.status).toBe("completed");
    expect(workflow.steps).toHaveLength(2);

    const workflowStatusRes = await actionApp.request(
      `/api/sessions/session-workflow/workflows/${workflow.workflowRunId}`,
    );
    expect(workflowStatusRes.status).toBe(200);
    const workflowStatus = await workflowStatusRes.json();
    expect(workflowStatus.status).toBe("completed");

    const lastRecordRes = await runtimeApp.request(
      "/api/sessions/session-workflow/runtimes/image-workflow-demo/image-generator/last-record",
    );
    expect(lastRecordRes.status).toBe(200);
    const lastRecord = await lastRecordRes.json();
    expect(lastRecord.record).not.toBeNull();
    expect(lastRecord.record.runtimeId).toBe("image-generator");
  });

  it("processes approval callbacks against a real session", async () => {
    const approvalRes = await approvalApp.request(
      "/api/sessions/session-approval/approvals/callback",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          interactionId: "interaction-1",
          decision: "approved",
          response: { source: "ui" },
        }),
      },
    );

    expect(approvalRes.status).toBe(200);
    const body = await approvalRes.json();
    expect(body.status).toBe("processed");
    expect(body.interactionId).toBe("interaction-1");
  });
});
