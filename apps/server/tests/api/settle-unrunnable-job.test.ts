import { afterEach, expect, it, vi } from "vitest";
import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMemoryStore } from "@covel/store/memory";
import {
  bootstrapApi,
  type ApiBootstrapResult,
} from "../../src/routes/api/bootstrap.js";
import {
  createRuntimeJob,
  getRuntimeJob,
} from "../../src/routes/api/plugin-rpc/jobs.js";
import {
  sessionApprovalScope,
  sessionIncarnationIdentity,
} from "../../src/routes/api/session/session-guard.js";
import { closeTestApi } from "../helpers/close-api.js";

let boot: ApiBootstrapResult | undefined;
afterEach(async () => {
  await closeTestApi(boot);
  boot = undefined;
});

it("does not hold the next request to the settle wait of a job no model can run", async () => {
  const root = await mkdtemp(join(tmpdir(), "covel-settle-unrunnable-"));
  await mkdir(join(root, "plugins"), { recursive: true });
  const store = createMemoryStore();
  const pluginId = "memory-probe";
  const sessionId = "settle-session";
  const now = new Date().toISOString();
  await store.createSession({
    id: sessionId,
    status: "active",
    phase: "playing",
    locale: "en-US",
    completedPlayerTurns: 1,
    setupRuntimes: {},
    seats: [
      { id: "main", controller: "human", role: "player", characters: "auto" },
    ],
    activePlugins: [pluginId],
    metadata: {
      approvalScopeNonce: "approval",
      sessionIncarnationNonce: "incarnation",
    },
    createdAt: now,
    updatedAt: now,
  });
  const session = (await store.getSession(sessionId))!;
  const jobKey = { sessionId, pluginId, jobId: "needs-credentials" };
  await createRuntimeJob(store, {
    ...jobKey,
    runtimeId: pluginId,
    settle: "before-next-execution",
    maxSettleWaitMs: 30_000,
    origin: { activation: "stage", sourceTurnId: "turn-1" },
    payload: {
      schemaVersion: 1,
      expectedSessionIncarnation: sessionIncarnationIdentity(session),
      expectedApprovalScope: sessionApprovalScope(session, pluginId),
      locale: "en-US",
      descriptor: {
        jobId: jobKey.jobId,
        pluginId,
        runtimeId: pluginId,
        pluginVersion: "1.0.0",
        sourceTurnId: "turn-1",
        sourceExecutionId: "execution-1",
        sourceExecutionStartedAt: now,
        turnDigest: {
          turnId: "turn-1",
          playerMessage: "hello",
          actions: [],
          lastPlayerInput: null,
          narrativeText: "",
          toolCallSummaries: [],
          runtimeResults: [],
        },
        upstreamResults: [],
      },
    },
  });
  const serverReady = vi.fn(() => false);
  boot = await bootstrapApi({
    pluginsDir: join(root, "plugins"),
    covelHome: join(root, "home"),
    worldsDirs: [],
    store,
    storeBackend: "memory",
    llmAdapter: { generate: vi.fn() },
    canRunRuntimeJobWithServerServices: serverReady,
  });
  await boot.startupMaintenance;

  const startedAt = performance.now();
  const response = await boot.app.request(
    `/api/sessions/${sessionId}/lorebook/missing`,
    { method: "DELETE" },
  );
  expect(response.status).toBe(404);
  expect(performance.now() - startedAt).toBeLessThan(5_000);
  expect(serverReady).toHaveBeenCalled();
  expect(await getRuntimeJob(store, jobKey)).toMatchObject({
    status: "queued",
  });
  const traces = await store.listTraceEvents(sessionId);
  expect(traces.map((trace) => trace.type)).toContain(
    "execution.settle-skipped",
  );
  expect(traces.map((trace) => trace.type)).not.toContain(
    "execution.settle-timeout",
  );
}, 20_000);
