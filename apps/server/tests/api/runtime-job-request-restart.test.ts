import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type DataStore } from "@covel/store";
import { createSqliteStore } from "@covel/store/sqlite";
import { createPluginRuntimeGateway } from "@covel/runtime";
import type { AiStack } from "../../src/ai-setup.js";
import { createPerRequestLlmMiddleware } from "../../src/middleware/per-request-llm.js";
import { hasServerRuntimeJobCredentials } from "../../src/runtime-job-readiness.js";
import {
  bootstrapApi,
  type ApiBootstrapResult,
} from "../../src/routes/api/bootstrap.js";
import {
  createRuntimeJob,
  getRuntimeJob,
} from "../../src/routes/api/plugin-rpc/jobs.js";
import type { createRuntimeJobCredentials } from "../../src/routes/api/plugin-rpc/runtime-job-credentials.js";
import {
  hashSessionOwnerToken,
  sessionApprovalScope,
  sessionIncarnationIdentity,
} from "../../src/routes/api/session/session-guard.js";
import { closeTestApi } from "../helpers/close-api.js";

afterEach(() => vi.unstubAllEnvs());

describe("request-only runtime jobs across a SQLite restart", () => {
  it("retains the source snapshot but requires fresh owner-authorized credentials", async () => {
    vi.stubEnv("DEPLOYMENT_TIER", "commercial");
    vi.stubEnv("COVEL_DESKTOP_REST_TOKEN", "");
    const root = await mkdtemp(join(tmpdir(), "covel-request-restart-"));
    const pluginId = "restart-probe";
    const pluginDir = join(root, "plugins", pluginId);
    const database = join(root, "jobs.sqlite");
    const owner = "synthetic-session-owner";
    const oldKey = "synthetic-provider-key-before-restart";
    const freshKey = "synthetic-provider-key-after-restart";
    const jobKey = {
      sessionId: "restart-session",
      pluginId,
      jobId: "source-job",
    };
    const sourceDigest = {
      turnId: "source-turn-A",
      playerMessage: "Original submitted action A",
      lastPlayerInput: null,
      narrativeText: "Original narrative A",
      toolCallSummaries: [],
      runtimeResults: [],
    };
    let store: DataStore | undefined;
    let boot: ApiBootstrapResult | undefined;
    let credentials: ReturnType<typeof createRuntimeJobCredentials> | undefined;
    const generateText = vi.fn(
      async (
        _input: unknown,
        options?: { apiKeys?: Record<string, string> },
      ) => {
        expect(options?.apiKeys?.target).toBe(freshKey);
        return {
          text: "completed",
          finishReason: "stop",
          usage: { inputTokens: 0, outputTokens: 0 },
        };
      },
    );
    const gateway = {
      resolveSlot: vi.fn(
        (
          _model: string | undefined,
          options?: { apiKeys?: Record<string, string> },
        ) => ({
          presetId: "background",
          provider: "target",
          model: "synthetic-model",
          protocol: "openai-chat-v1",
          tag: "text",
          metadata: {},
          apiKey: options?.apiKeys?.target,
        }),
      ),
      generateText,
      generateObject: vi.fn(),
    };
    const serverReady = vi.fn(() =>
      hasServerRuntimeJobCredentials(gateway, "background", {}),
    );
    const defaultLlmAdapter = { generate: vi.fn() };
    const defaultPluginGateway = createPluginRuntimeGateway(gateway);
    const start = async () => {
      const result = await bootstrapApi({
        pluginsDir: join(root, "plugins"),
        covelHome: join(root, "home"),
        worldsDirs: [],
        store: store!,
        storeBackend: "sqlite",
        llmAdapter: defaultLlmAdapter,
        pluginGateway: defaultPluginGateway,
        canRunRuntimeJobWithServerServices: serverReady,
        perRequestMiddleware: [
          async (c, next) => {
            credentials = c.get("runtimeJobCredentials");
            await next();
          },
          createPerRequestLlmMiddleware({
            ai: { gateway } as unknown as AiStack,
            envApiKeys: {},
            defaultLlmAdapter,
            defaultPluginGateway,
          }),
        ],
      });
      await result.startupMaintenance;
      await result.app.request("/api/health");
      return result;
    };
    const request = (token: string, apiKey?: string) =>
      boot!.app.request(`/api/sessions/${jobKey.sessionId}/plugins`, {
        headers: {
          Authorization: `Bearer ${token}`,
          ...(apiKey
            ? {
                "X-Provider-Keys": Buffer.from(
                  JSON.stringify({ target: apiKey }),
                ).toString("base64"),
              }
            : {}),
        },
      });
    try {
      await mkdir(pluginDir, { recursive: true });
      await writeFile(
        join(pluginDir, "package.json"),
        JSON.stringify({ name: pluginId, version: "1.0.0", type: "module" }),
      );
      await writeFile(
        join(pluginDir, "PLUGIN.md"),
        `---
id: ${pluginId}
kind: plugin
description: SQLite request restart fixture
version: 1.0.0
runtime:
  type: function
  schedule:
    stage: post-turn
    trigger:
      type: auto
    completion:
      mode: detached
  function:
    handler: ./handler.js
  io:
    inputs:
      turn:
        from:
          kernel: turn-digest@1
  effects:
    writes:
      - plugin-data:self:results
---
`,
      );
      await writeFile(
        join(pluginDir, "handler.js"),
        `export default async (ctx) => {
        const digest = ctx.inputs.turn.value;
        await ctx.gateway.generateText({ messages: [{ role: "user", content: digest.playerMessage }] });
        return { outcome: "success", value: {}, effects: { pluginData: [{ namespace: "results", key: "completed", value: { digest } }] } };
      };`,
      );
      store = createSqliteStore(database);
      boot = await start();
      // Stop consumption before publishing: model an enqueued job whose original
      // request handoff is still in memory when this host shuts down.
      await boot.runtimeJobWorker.close();
      const now = new Date().toISOString();
      await store.createSession({
        id: jobKey.sessionId,
        status: "active",
        phase: "playing",
        locale: "en-US",
        completedPlayerTurns: 0,
        setupRuntimes: {},
        activePlugins: [pluginId],
        metadata: {
          ownerTokenHash: hashSessionOwnerToken(owner),
          approvalScopeNonce: "approval",
          sessionIncarnationNonce: "incarnation",
        },
        createdAt: now,
        updatedAt: now,
      });
      const session = (await store.getSession(jobKey.sessionId))!;
      await createRuntimeJob(store, {
        ...jobKey,
        runtimeId: pluginId,
        maxQueueMs: 60_000,
        origin: { activation: "stage", sourceTurnId: sourceDigest.turnId },
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
            sourceTurnId: sourceDigest.turnId,
            sourceExecutionId: "source-execution-A",
            sourceExecutionStartedAt: now,
            turnDigest: sourceDigest,
            upstreamResults: [],
          },
        },
      });
      expect((await request(owner, oldKey)).status).toBe(200);
      expect(credentials!.size).toBe(1);
      const queuedBeforeRestart = await getRuntimeJob(store, jobKey);
      expect(queuedBeforeRestart).toMatchObject({
        status: "queued",
        attempt: 0,
      });
      await closeTestApi(boot);
      boot = undefined;
      expect(credentials!.size).toBe(0);
      await store.close();
      store = undefined;
      expect((await readFile(database)).includes(Buffer.from(oldKey))).toBe(
        false,
      );

      // A new connection and a new bootstrap own neither the old credential map
      // nor the old worker. Only durable SQLite state crosses this boundary.
      store = createSqliteStore(database);
      expect(await getRuntimeJob(store, jobKey)).toEqual(queuedBeforeRestart);
      serverReady.mockClear();
      boot = await start();
      await vi.waitFor(() => expect(serverReady).toHaveBeenCalled());
      expect(credentials!.size).toBe(0);
      expect((await request(owner)).status).toBe(200);
      expect((await request("wrong-owner", freshKey)).status).toBe(401);
      expect(credentials!.size).toBe(0);
      expect(await getRuntimeJob(store, jobKey)).toMatchObject({
        status: "queued",
        attempt: 0,
        payload: { descriptor: { turnDigest: sourceDigest } },
      });
      expect(generateText).not.toHaveBeenCalled();
      expect(defaultLlmAdapter.generate).not.toHaveBeenCalled();

      expect((await request(owner, freshKey)).status).toBe(200);
      boot.runtimeJobWorker.wake();
      await vi.waitFor(async () =>
        expect(await getRuntimeJob(store!, jobKey)).toMatchObject({
          status: "succeeded",
          attempt: 1,
        }),
      );
      expect(generateText).toHaveBeenCalledOnce();
      expect(generateText.mock.calls[0]?.[0]).toMatchObject({
        messages: [{ role: "user", content: sourceDigest.playerMessage }],
      });
      expect(
        await store.getPluginData(
          jobKey.sessionId,
          pluginId,
          "results",
          "completed",
        ),
      ).toMatchObject({ value: { digest: sourceDigest } });
      expect(credentials!.size).toBe(0);
      expect(await getRuntimeJob(store, jobKey)).toMatchObject({
        payload: { descriptor: { turnDigest: sourceDigest } },
      });
      await closeTestApi(boot);
      boot = undefined;
      await store.close();
      store = undefined;
      const persisted = await readFile(database);
      for (const secret of [oldKey, freshKey])
        expect(persisted.includes(Buffer.from(secret))).toBe(false);
    } finally {
      await closeTestApi(boot);
      await store?.close();
      await rm(root, { recursive: true, force: true });
    }
  });
});
