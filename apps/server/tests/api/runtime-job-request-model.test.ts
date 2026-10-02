import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SlotOverridesInput } from "@covel/ai-provider";
import {
  createPluginRuntimeGateway,
  type PluginLlmModelTarget,
} from "@covel/runtime";
import { createMemoryStore } from "@covel/store/memory";
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
import {
  sessionApprovalScope,
  sessionIncarnationIdentity,
} from "../../src/routes/api/session/session-guard.js";
import { closeTestApi } from "../helpers/close-api.js";

const pluginId = "pinned-model-job";
const sessionId = "pinned-model-session";
const b64 = (value: unknown) =>
  Buffer.from(JSON.stringify(value)).toString("base64");

interface GatewayCallOptions {
  readonly apiKeys?: Record<string, string>;
  readonly envApiKeys?: Record<string, string>;
  readonly slotOverrides?: SlotOverridesInput;
}

/** Resolves only what the request or plugin explicitly bound — no implicit default. */
function resolveBound(
  presetId: string | undefined,
  options: GatewayCallOptions | undefined,
) {
  const binding = presetId
    ? options?.slotOverrides?.slotBindings?.[presetId]
    : undefined;
  const ref = binding && "modelRef" in binding ? binding.modelRef : presetId;
  const preset = options?.slotOverrides?.customPresets?.find(
    (candidate) => candidate.id === ref,
  );
  if (!preset) throw new Error(`preset not found: ${String(presetId)}`);
  return {
    presetId: preset.id,
    provider: preset.provider,
    model: preset.model,
    protocol: "openai-chat-v1",
    tag: "text",
    metadata: {},
    apiKey:
      options?.apiKeys?.[preset.provider] ??
      options?.envApiKeys?.[preset.provider],
  };
}

describe("detached job readiness uses the source request's model configuration", () => {
  let root: string | undefined;
  let boot: ApiBootstrapResult | undefined;

  afterEach(async () => {
    await closeTestApi(boot);
    boot = undefined;
    if (root) await rm(root, { recursive: true, force: true });
    root = undefined;
  });

  it.each([
    {
      label: "the plugin's own model target",
      provider: "plugin-provider",
      slotConfig: undefined,
    },
    {
      label: "a request-selected binding for the plugin's role",
      provider: "user-provider",
      slotConfig: {
        slotBindings: { default: { modelRef: "user-preset" } },
        customPresets: [
          { id: "user-preset", provider: "user-provider", model: "user-model" },
        ],
      },
    },
  ])(
    "runs with request credentials for $label",
    async ({ provider, slotConfig }) => {
      root = await mkdtemp(join(tmpdir(), "covel-request-model-"));
      const pluginDir = join(root, "plugins", pluginId);
      await mkdir(pluginDir, { recursive: true });
      await writeFile(
        join(pluginDir, "package.json"),
        JSON.stringify({ name: pluginId, version: "1.0.0", type: "module" }),
      );
      await writeFile(
        join(pluginDir, "llm.toml"),
        `[plugin.default]\nprovider = "plugin-provider"\nmodel = "plugin-model"\n`,
      );
      await writeFile(
        join(pluginDir, "PLUGIN.md"),
        `---
id: ${pluginId}
kind: plugin
description: Detached job pinned to a plugin model target
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
      - plugin-data:self:results
---
`,
      );
      await writeFile(
        join(pluginDir, "handler.js"),
        `export default async (ctx) => {
          await ctx.gateway.generateText({ messages: [{ role: "user", content: "extract" }] });
          return { outcome: "success", value: {}, effects: { pluginData: [{ namespace: "results", key: "done", value: true }] } };
        };`,
      );

      const requestKey = `synthetic-${provider}-key`;
      const generateText = vi.fn(
        async (_input: unknown, _options?: GatewayCallOptions) => ({
          text: "ok",
          finishReason: "stop",
          usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
        }),
      );
      const gateway = {
        resolveSlot: vi.fn(resolveBound),
        generateText,
        generateObject: vi.fn(),
      };
      const modelTargets = new Map<string, PluginLlmModelTarget>();
      const serverReady = vi.fn(({ model }: { model: string | undefined }) =>
        hasServerRuntimeJobCredentials(gateway, model, {}, modelTargets),
      );
      const defaultLlmAdapter = { generate: vi.fn() };
      const defaultPluginGateway = createPluginRuntimeGateway(gateway);
      const store = createMemoryStore();
      boot = await bootstrapApi({
        pluginsDir: join(root, "plugins"),
        covelHome: join(root, "home"),
        worldsDirs: [],
        store,
        storeBackend: "memory",
        llmAdapter: defaultLlmAdapter,
        pluginGateway: defaultPluginGateway,
        pluginModelTargets: modelTargets,
        canRunRuntimeJobWithServerServices: serverReady,
        perRequestMiddleware: [
          createPerRequestLlmMiddleware({
            ai: { gateway } as unknown as AiStack,
            modelTargets,
            envApiKeys: {},
            defaultLlmAdapter,
            defaultPluginGateway,
          }),
        ],
      });
      await boot.startupMaintenance;
      expect(boot.registry.get(pluginId)?.status).toBe("registered");

      const now = new Date().toISOString();
      await store.createSession({
        id: sessionId,
        status: "active",
        phase: "playing",
        locale: "en-US",
        completedPlayerTurns: 1,
        setupRuntimes: {},
        activePlugins: [pluginId],
        metadata: {
          approvalScopeNonce: "approval",
          sessionIncarnationNonce: "incarnation",
        },
        createdAt: now,
        updatedAt: now,
      });
      const session = (await store.getSession(sessionId))!;
      const jobKey = { sessionId, pluginId, jobId: "pinned-job" };
      await createRuntimeJob(store, {
        ...jobKey,
        runtimeId: pluginId,
        maxQueueMs: 60_000,
        origin: { activation: "stage", sourceTurnId: "source-turn" },
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
            sourceTurnId: "source-turn",
            sourceExecutionId: "source-execution",
            sourceExecutionStartedAt: now,
            turnDigest: {
              turnId: "source-turn",
              playerMessage: "",
              lastPlayerInput: null,
              narrativeText: "",
              toolCallSummaries: [],
              runtimeResults: [],
            },
            upstreamResults: [],
          },
        },
      });

      // The request that owns the session hands its configuration to the job.
      const response = await boot.app.request(
        `/api/sessions/${sessionId}/plugins`,
        {
          headers: {
            "X-Provider-Keys": b64({ [provider]: requestKey }),
            ...(slotConfig ? { "X-Slot-Config": b64(slotConfig) } : {}),
          },
        },
      );
      expect(response.status).toBe(200);
      // The worker drains outside any request scope.
      boot.runtimeJobWorker.wake();

      await vi.waitFor(async () =>
        expect(await getRuntimeJob(store, jobKey)).toMatchObject({
          status: "succeeded",
        }),
      );
      expect(generateText).toHaveBeenCalledOnce();
      expect(generateText.mock.calls[0]?.[1]?.apiKeys?.[provider]).toBe(
        requestKey,
      );
      expect(
        (await store.getPluginData(sessionId, pluginId, "results", "done"))
          ?.value,
      ).toBe(true);
    },
  );
});
