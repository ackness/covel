import { describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { createEventBus } from "@covel/events";
import {
  createPluginRegistry,
  type FunctionHandler,
  type LoadedRuntime,
  type PluginRegistryEntry,
  type PluginRuntimeGateway,
} from "@covel/plugin-loader";
import type { RuntimeManifest } from "@covel/shared";
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
import type { createRuntimeJobCredentials } from "../../src/routes/api/plugin-rpc/runtime-job-credentials.js";
import { closeTestApi } from "../helpers/close-api.js";
import { actionRoutes } from "../../src/routes/api/actions.js";
import { createInProcessSessionLock } from "../../src/lib/session-lock.js";

const SESSION_ID = "detached-action-session";
const PLUGIN_ID = "detached-action-plugin";
const PRODUCER_ID = `${PLUGIN_ID}/producer`;
const LEAF_ID = `${PLUGIN_ID}/leaf`;

describe("POST /api/actions — scheduler-detached runtime", () => {
  it("commits the source turn and durable queue row without running the leaf", async () => {
    const store = createMemoryStore();
    const eventBus = createEventBus(store);
    const registry = createPluginRegistry();
    const leafHandler = vi.fn<FunctionHandler>(async () => ({
      outcome: "success",
      value: {},
      effects: {
        pluginData: [
          { namespace: "tracks", key: "late", value: { status: "done" } },
        ],
      },
    }));
    const manifests: RuntimeManifest[] = [
      {
        name: PRODUCER_ID,
        pluginId: PLUGIN_ID,
        description: "narrative producer",
        version: "1.0.0",
        runtimeType: "function",
        handler: "./producer.js",
        stage: "narrative",
        outputKind: "story",
        trigger: { type: "auto" },
      },
      {
        name: LEAF_ID,
        pluginId: PLUGIN_ID,
        description: "detached media leaf",
        version: "1.0.0",
        runtimeType: "function",
        handler: "./leaf.js",
        stage: "post-turn",
        outputKind: "plugin",
        trigger: { type: "auto" },
        needs: [{ capability: "narrative-engine" }],
        inputs: {
          narrative: {
            from: { capability: "narrative-engine", cardinality: "one" },
            select: "/narrativeOutput",
            required: true,
          },
        },
        effects: {
          writes: ["plugin-data:self:tracks", "assets:*", "media:*"],
        },
        turnCompletion: {
          mode: "detached",
          maxQueueMs: 30_000,
          maxExecutionMs: 90_000,
          overlap: "serial",
          stalePolicy: "reject",
        },
      },
    ];
    const loaded = new Map<string, LoadedRuntime>([
      [
        PRODUCER_ID,
        {
          manifest: manifests[0]!,
          promptTemplate: "",
          handler: async () => ({
            outcome: "success",
            value: { narrativeOutput: "The source turn is complete." },
          }),
        },
      ],
      [
        LEAF_ID,
        {
          manifest: manifests[1]!,
          promptTemplate: "",
          handler: leafHandler,
        },
      ],
    ]);
    const parsed = manifests.map((manifest) => ({
      manifest,
      runtime: { type: manifest.runtimeType ?? "agent" },
      promptTemplate: "",
      rawFrontmatter: {},
    }));
    registry.register({
      id: PLUGIN_ID,
      summary: {
        id: PLUGIN_ID,
        name: PLUGIN_ID,
        description: "",
        pluginType: "plugin",
        runtimeCount: manifests.length,
      },
      manifests: parsed,
      loadedRuntimes: loaded,
      status: "registered",
      source: "builtin",
    } as PluginRegistryEntry);

    const runtimeJobWorker = { wake: vi.fn(), close: vi.fn(), activeCount: 0 };
    const app = new Hono();
    app.use("*", async (c, next) => {
      c.set("store", store);
      c.set("pluginRegistry", registry);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      c.set("llmAdapter", { generate: async () => ({}) } as any);
      c.set("loadRuntimeFn", async (manifest) => loaded.get(manifest.name));
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      c.set("toolExecutor", undefined as any);
      c.set("resolveModel", () => undefined);
      c.set("eventBus", eventBus);
      c.set("sessionLock", createInProcessSessionLock());
      c.set("runtimeJobWorker", runtimeJobWorker);
      await next();
    });
    app.route("/api/actions", actionRoutes);

    const now = new Date().toISOString();
    await store.createSession({
      id: SESSION_ID,
      status: "active",
      locale: "zh-CN",
      phase: "playing",
      completedPlayerTurns: 0,
      setupRuntimes: {},
      activePlugins: [PLUGIN_ID],
      metadata: {
        approvalScopeNonce: crypto.randomUUID(),
        sessionIncarnationNonce: crypto.randomUUID(),
      },
      createdAt: now,
      updatedAt: now,
    });

    const response = await app.request("/api/actions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        requestId: "detached-request",
        type: "send_message",
        sessionId: SESSION_ID,
        payload: { content: "continue" },
      }),
    });
    const stream = await response.text();

    expect(response.status).toBe(200);
    expect(stream).toContain("runtime.deferred");
    expect(stream).toContain("execution.completed");
    expect(leafHandler).not.toHaveBeenCalled();
    expect(runtimeJobWorker.wake).toHaveBeenCalledOnce();
    const [job] = await store.listPluginData(
      SESSION_ID,
      PLUGIN_ID,
      "_runtime_jobs",
    );
    expect(job?.value).toMatchObject({
      status: "queued",
      runtimeId: LEAF_ID,
      maxQueueMs: 30_000,
      maxExecutionMs: 90_000,
      payload: {
        descriptor: {
          runtimeId: LEAF_ID,
          upstreamResults: [{ runtimeId: PRODUCER_ID, status: "success" }],
        },
      },
    });
    await expect(
      store.listJobStatus(SESSION_ID, { jobId: job?.key }),
    ).resolves.toMatchObject([{ state: "queued", sequence: 0 }]);
  });
});

describe("bootstrap detached job completion", () => {
  it.each<{
    value: Record<string, unknown>;
    succeeds: boolean;
    error?: string;
    credentialSource?: "request" | "waiting" | "unready-request";
  }>([
    { value: { generated: true }, succeeds: true, error: undefined },
    {
      value: { checkCredentials: true },
      succeeds: true,
      credentialSource: "request",
    },
    {
      value: { checkCredentials: true },
      succeeds: true,
      credentialSource: "waiting",
    },
    {
      value: { checkCredentials: true },
      succeeds: true,
      credentialSource: "unready-request",
    },
    {
      value: { status: "failed" },
      succeeds: false,
      error: "detached runtime reported a failed business result",
    },
    {
      value: { error: "synthetic business failure" },
      succeeds: false,
      error: "synthetic business failure",
    },
    {
      value: { throwFromHandler: true },
      succeeds: false,
      error: "synthetic runtime failure",
    },
    {
      value: { rejectProposal: true },
      succeeds: false,
      error: "detached runtime proposals did not commit",
    },
  ])(
    "settles domain writes and job completion together for $value",
    async ({ value, succeeds, error, credentialSource }) => {
      const root = await mkdtemp(join(tmpdir(), "covel-atomic-job-"));
      const pluginId = "atomic-job";
      const runtimeId = pluginId;
      const pluginDir = join(root, pluginId);
      const store = createMemoryStore();
      let boot: ApiBootstrapResult | undefined;
      try {
        await mkdir(pluginDir);
        await writeFile(
          join(pluginDir, "package.json"),
          JSON.stringify({
            name: pluginId,
            version: "1.0.0",
            type: "module",
          }),
        );
        await writeFile(
          join(pluginDir, "PLUGIN.md"),
          `---
id: ${runtimeId}
kind: plugin
description: Atomic job fixture
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
  effects:
    writes:
      - plugin-data:self:tracks
---
`,
        );
        await writeFile(
          join(pluginDir, "handler.js"),
          `export default async (ctx) => {
          const value = ${JSON.stringify(value)};
          if (value.checkCredentials) value.credentialSource = (await ctx.gateway.generateText({messages: []})).text;
          if (value.throwFromHandler) throw new Error("synthetic runtime failure");
          return {
            outcome: "success",
            value,
            effects: { pluginData: [{ namespace: value.rejectProposal ? "undeclared" : "tracks", key: "failed", value: { written: true } }] },
          };
        };`,
        );
        let credentials:
          ReturnType<typeof createRuntimeJobCredentials> | undefined;
        const serverReady = vi.fn(
          () =>
            credentialSource !== "waiting" &&
            credentialSource !== "unready-request",
        );
        const makeGateway = (text: string) =>
          ({
            generateText: vi.fn(async () => ({
              text,
              finishReason: "stop",
              usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
            })),
          }) as unknown as PluginRuntimeGateway;
        const serverGateway = makeGateway("server");
        boot = await bootstrapApi({
          pluginsDir: root,
          store,
          storeBackend: "memory",
          llmAdapter: { generate: vi.fn() },
          pluginGateway: serverGateway,
          canRunRuntimeJobWithServerServices: serverReady,
          perRequestMiddleware: [
            async (c, next) => {
              credentials = c.get("runtimeJobCredentials");
              await next();
            },
          ],
        });
        await boot.app.request("/api/health");
        expect(boot.registry.get(pluginId)?.status).toBe("registered");
        await boot.startupMaintenance;
        const now = new Date().toISOString();
        await store.createSession({
          id: "atomic-session",
          status: "active",
          locale: "en-US",
          phase: "playing",
          completedPlayerTurns: 0,
          setupRuntimes: {},
          activePlugins: [pluginId],
          metadata: {
            approvalScopeNonce: crypto.randomUUID(),
            sessionIncarnationNonce: crypto.randomUUID(),
          },
          createdAt: now,
          updatedAt: now,
        });
        const session = (await store.getSession("atomic-session"))!;
        const key = { sessionId: session.id, pluginId, jobId: "atomic-job" };
        await createRuntimeJob(store, {
          ...key,
          runtimeId,
          origin: { activation: "stage", sourceTurnId: "source-turn" },
          payload: {
            schemaVersion: 1,
            expectedSessionIncarnation: sessionIncarnationIdentity(session),
            expectedApprovalScope: sessionApprovalScope(session, pluginId),
            locale: session.locale,
            descriptor: {
              jobId: key.jobId,
              pluginId,
              runtimeId,
              pluginVersion: "1.0.0",
              sourceTurnId: "source-turn",
              sourceExecutionId: "source-execution",
              turnDigest: {
                turnId: "source-turn",
                playerMessage: "",
                lastPlayerInput: null,
                narrativeText: "",
                toolCallSummaries: [],
                runtimeResults: [],
              },
              sourceExecutionStartedAt: now,
              upstreamResults: [],
            },
          },
        });
        const credentialKey = {
          jobId: key.jobId,
          sessionId: session.id,
          expectedSessionIncarnation: sessionIncarnationIdentity(session),
        };
        const requestGateway = makeGateway("request");
        const requestReady = vi.fn(
          () => credentialSource !== "unready-request",
        );
        if (
          credentialSource === "request" ||
          credentialSource === "unready-request"
        ) {
          credentials!.register(credentialKey, {
            llm: { generate: vi.fn() },
            gateway: requestGateway,
            canRun: requestReady,
          });
        }
        boot.runtimeJobWorker.wake();
        if (credentialSource === "unready-request") {
          await vi.waitFor(() => expect(serverReady).toHaveBeenCalled());
          await expect(getRuntimeJob(store, key)).resolves.toMatchObject({
            status: "queued",
            attempt: 0,
          });
          expect(requestGateway.generateText).not.toHaveBeenCalled();
          expect(serverGateway.generateText).not.toHaveBeenCalled();
          expect(credentials!.peek(credentialKey)).toBeUndefined();
          credentials!.register(credentialKey, {
            llm: { generate: vi.fn() },
            gateway: requestGateway,
            canRun: () => true,
          });
          boot.runtimeJobWorker.wake();
        }
        if (credentialSource === "waiting") {
          await vi.waitFor(() => expect(serverReady).toHaveBeenCalled());
          await expect(getRuntimeJob(store, key)).resolves.toMatchObject({
            status: "queued",
          });
          expect(serverGateway.generateText).not.toHaveBeenCalled();
          serverReady.mockReturnValue(true);
          boot.runtimeJobWorker.wake();
        }
        await vi.waitFor(async () => {
          await expect(getRuntimeJob(store, key)).resolves.toMatchObject({
            status: succeeds ? "succeeded" : "failed",
            ...(succeeds ? {} : { reason: "execution-failed", error }),
          });
        });
        if (credentialSource === "request") {
          expect(serverReady).not.toHaveBeenCalled();
          expect(requestGateway.generateText).toHaveBeenCalledOnce();
          expect(serverGateway.generateText).not.toHaveBeenCalled();
        } else if (credentialSource === "unready-request") {
          expect(requestGateway.generateText).toHaveBeenCalledOnce();
          expect(serverGateway.generateText).not.toHaveBeenCalled();
        } else if (credentialSource === "waiting") {
          expect(serverGateway.generateText).toHaveBeenCalledOnce();
        }
        const written = await store.getPluginData(
          session.id,
          pluginId,
          "tracks",
          "failed",
        );
        if (succeeds)
          expect(written).toMatchObject({ value: { written: true } });
        else expect(written).toBeNull();
        expect((await store.listTurnResults(session.id))[0]?.commitStatus).toBe(
          succeeds ? "committed" : "failed",
        );
      } finally {
        await closeTestApi(boot);
        await store.close();
        await rm(root, { recursive: true, force: true });
      }
    },
  );
});
