/**
 * Tests for the suspend/resume API routes.
 *
 * POST   /api/sessions/:id/suspensions/:suspensionId/resume
 * DELETE /api/sessions/:id/suspensions/:suspensionId
 * GET    /api/sessions/:id/suspensions
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { Hono } from "hono";
import {
  createRpcApprovalGate,
  COMMUNITY_SERVER_CODE_ACTION,
  type RpcApprovalGate,
} from "@covel/approval";
import type { BudgetOptions } from "@covel/context";
import { type DataStore, type SuspensionRecord } from "@covel/store";
import { readSuspensionWriteDigest } from "@covel/store/session";
import { createMemoryStore } from "@covel/store/memory";
import { __resetSweepClockForTests } from "../../src/routes/api/suspension-sweep.js";
import {
  createPluginRegistry,
  type PluginRegistry,
} from "@covel/plugin-loader";
import type {
  DeferredRuntimeJob,
  ExecutionContext,
  RuntimeManifest,
} from "@covel/shared";
import type { FunctionHandler } from "@covel/shared/plugin-runtime";
import {
  createHookPipeline,
  createToolExecutor,
  type HookPipeline,
} from "@covel/runtime";
import { suspendTool } from "@covel/tools";
import { makeErrorHandler } from "../../src/api-error.js";
import { resumeRoutes } from "../../src/routes/api/resume.js";
import { listRuntimeJobs } from "../../src/routes/api/plugin-rpc/jobs.js";
import {
  SessionLockTimeoutError,
  createInProcessSessionLock,
  type SessionLock,
} from "../../src/lib/session-lock.js";
import {
  SESSION_INCARNATION_KEY,
  sessionApprovalScope,
} from "../../src/routes/api/session/session-guard.js";
import { setSessionWorld } from "../helpers/session-world.js";

// ── Helpers ──────────────────────────────────────────────────────────

type Deps = {
  rpcApprovalGate?: RpcApprovalGate;
  contextBudget?: Omit<BudgetOptions, "estimator">;
  store: DataStore;
  pluginRegistry: PluginRegistry;
  llmAdapter: { generate: () => Promise<unknown> };
  loadRuntimeFn: () => Promise<undefined>;
  toolExecutor: {
    execute: () => Promise<unknown>;
    getToolInfo: () => undefined;
  };
  resolveModel: () => undefined;
  hookPipeline?: HookPipeline;
  prepareToolsForSession?: (sessionId: string) => Promise<void>;
};

function createTestApp(
  deps: Deps,
  sessionLock: SessionLock = createInProcessSessionLock(),
) {
  const app = new Hono<{
    Variables: {
      store: DataStore;
      pluginRegistry: PluginRegistry;
      llmAdapter: Deps["llmAdapter"];
      loadRuntimeFn: Deps["loadRuntimeFn"];
      toolExecutor: Deps["toolExecutor"];
      resolveModel: Deps["resolveModel"];
    };
  }>();

  app.onError(
    makeErrorHandler("[resume test]", process.env.NODE_ENV !== "production"),
  );
  app.use("*", async (c, next) => {
    if (deps.contextBudget) c.set("turnContextBudget", deps.contextBudget);
    c.set("store", deps.store);
    c.set("pluginRegistry", deps.pluginRegistry);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    c.set("llmAdapter", deps.llmAdapter as any);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    c.set("loadRuntimeFn", deps.loadRuntimeFn as any);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    c.set("toolExecutor", deps.toolExecutor as any);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    c.set("resolveModel", deps.resolveModel as any);
    c.set("sessionLock", sessionLock);
    if (deps.rpcApprovalGate) c.set("rpcApprovalGate", deps.rpcApprovalGate);
    if (deps.prepareToolsForSession) {
      c.set("prepareToolsForSession", deps.prepareToolsForSession);
    }
    if (deps.hookPipeline) {
      c.set("hookPipeline", deps.hookPipeline);
    }
    await next();
  });

  app.route("/api/sessions", resumeRoutes);
  return app;
}

async function createSession(store: DataStore, sessionId = "sess-1") {
  await store.createSession({
    locale: "zh-CN",
    phase: "playing",
    setupRuntimes: {},
    seats: [
      { id: "main", controller: "human", role: "player", characters: "auto" },
    ],
    metadata: {
      approvalScopeNonce: globalThis.crypto.randomUUID(),
      sessionIncarnationNonce: globalThis.crypto.randomUUID(),
    },
    id: sessionId,
    worldId: "test-world",
    status: "active",
    completedPlayerTurns: 1,

    activePlugins: ["test-plugin"],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
}

async function createSuspension(
  store: DataStore,
  overrides?: Partial<{
    id: string;
    runtimeId: string;
    sessionId: string;
    resolvedAt: string;
    resumeSchema: unknown;
    createdAt: string;
    executionContext: ExecutionContext;
    takenUnder: SuspensionRecord["pendingContinuation"]["takenUnder"];
    pendingProposals: SuspensionRecord["pendingContinuation"]["pendingProposals"];
    withheldRuntimeJobs: readonly DeferredRuntimeJob[];
  }>,
) {
  const suspension = {
    id: overrides?.id ?? "susp-1",
    sessionId: overrides?.sessionId ?? "sess-1",
    turnId: "turn-1",
    runtimeId: overrides?.runtimeId ?? "test-plugin",
    pluginId: "test-plugin",
    reason: "Need player input",
    resumeSchema: overrides?.resumeSchema ?? {
      type: "object",
      properties: { name: { type: "string" } },
      required: ["name"],
    },
    pendingContinuation: {
      takenUnder: overrides?.takenUnder ?? {
        playerTurns: 0,
        pluginVersion: "0.0.0",
        writes: [],
      },
      executionContext: {
        executionId: crypto.randomUUID(),
        origin: "player" as const,
        countPolicy: "complete-player-turn" as const,
        logicalTurnId: crypto.randomUUID(),
      },
      messages: [
        { role: "system", content: "You are a test agent." },
        {
          role: "tool",
          content: JSON.stringify({ suspended: true }),
          toolCallId: "tc-suspend-1",
        },
      ],
      toolCallsSoFar: [],
      pendingProposals: overrides?.pendingProposals ?? [],
      ...(overrides?.executionContext
        ? { executionContext: overrides.executionContext }
        : {}),
      ...(overrides?.withheldRuntimeJobs
        ? { withheldRuntimeJobs: overrides.withheldRuntimeJobs }
        : {}),
      suspendToolCallId: "tc-suspend-1",
    },
    createdAt: overrides?.createdAt ?? new Date().toISOString(),
    resolvedAt: overrides?.resolvedAt,
  };
  await store.saveSuspension(suspension);
  return suspension;
}

// Default LLM that returns a simple narrative on resume
function makeDefaultLLM() {
  return {
    generate: async () => ({
      content: '{"narrativeOutput": "Resume complete."}',
      toolCalls: [],
      finishReason: "stop",
      usage: { inputTokens: 5, outputTokens: 5 },
    }),
  };
}

const TEST_MANIFEST: RuntimeManifest = {
  name: "test-plugin",
  pluginId: "test-plugin",
  description: "Resume fixture runtime",
  stage: "narrative",
  trigger: { type: "auto" as const },
  model: "gpt-4o-mini",
  // This fixture emulates a narrator-style runtime that appends to the
  // main feed on resume. After 2026-04-24, only `outputKind: 'story'`
  // runtimes produce `narrative.append` proposals — other kinds keep
  // their text internal to the RuntimeResult.
  outputKind: "story" as const,
  userSettings: [
    { key: "tone", type: "select", default: "manifest", label: "Tone" },
    {
      key: "detail",
      type: "number",
      default: 1,
      label: "Detail",
    },
    {
      key: "fallback",
      type: "select",
      default: "manifest-only",
      label: "Fallback",
    },
  ],
};

/** A detached runtime of the same plugin, for a job the suspended turn held back. */
const HELD_BACK_MANIFEST: RuntimeManifest = {
  name: "test-plugin/later",
  pluginId: "test-plugin",
  description: "Detached follow-up fixture",
  runtimeType: "function",
  stage: "post-turn",
  outputKind: "system",
  trigger: { type: "auto" },
  turnCompletion: { mode: "detached" },
};

function heldBackJob(): DeferredRuntimeJob {
  return {
    jobId: "held-back-job",
    runtimeId: HELD_BACK_MANIFEST.name,
    pluginId: HELD_BACK_MANIFEST.pluginId,
    sourceTurnId: "turn-1",
    sourceExecutionId: "execution-before-suspend",
    sourceExecutionStartedAt: "2026-10-29T00:00:00.000Z",
    turnDigest: {
      turnId: "turn-1",
      playerMessage: "",
      actions: [],
      lastPlayerInput: null,
      narrativeText: "",
      toolCallSummaries: [],
      runtimeResults: [],
    },
    upstreamResults: [],
  };
}

function makeDefaultDeps(
  store: DataStore,
  overrides?: Partial<Deps>,
  manifest: RuntimeManifest = TEST_MANIFEST,
  others: readonly RuntimeManifest[] = [],
): Deps {
  const pluginRegistry = createPluginRegistry();
  // Register the test plugin so resume route can find the runtime manifest
  pluginRegistry.register({
    id: "test-plugin",
    summary: {
      id: "test-plugin",
      name: "Test Plugin",
      description: "",
      kind: "plugin",
      runtimeCount: 1,
    },
    source: "builtin",
    packageManifest: {
      plugin: {
        id: "test-plugin",
        kind: "plugin",
        description: "Resume fixture",
      },
      manifest: {
        kind: "plugin",
        name: "test-plugin",
        pluginId: "test-plugin",
        description: "Resume fixture",
        userSettings: TEST_MANIFEST.userSettings,
      },
      promptTemplate: "",
      rawFrontmatter: {},
    },
    manifests: [manifest, ...others].map((declared) => ({
      runtime: {},
      manifest: declared,
      promptTemplate: "Test prompt",
      rawFrontmatter: {},
    })),
    loadedRuntimes: new Map(),
    status: "registered",
  });

  return {
    store,
    pluginRegistry,
    llmAdapter: makeDefaultLLM(),
    loadRuntimeFn: async () =>
      ({
        manifest,
        promptTemplate: "Test prompt",
      }) as never,
    toolExecutor: {
      execute: async () => ({
        result: "{}",
        parsedResult: {},
        success: true,
        toolCallId: "",
        name: "",
      }),
      getToolInfo: () => undefined,
    },
    resolveModel: () => undefined,
    ...overrides,
  };
}

// ── Tests ─────────────────────────────────────────────────────────────

describe("Resume Routes", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });
  let store: DataStore;

  beforeEach(async () => {
    store = createMemoryStore();
    await createSession(store);
  });

  describe("POST /api/sessions/:id/suspensions/:suspensionId/resume", () => {
    it("asks for each missing grant before claiming or loading the continuation", async () => {
      const gate = createRpcApprovalGate();
      const deps = makeDefaultDeps(store, { rpcApprovalGate: gate });
      const entry = deps.pluginRegistry.get("test-plugin");
      if (!entry?.manifests) throw new Error("expected fixture runtimes");
      deps.pluginRegistry.register({
        ...entry,
        source: "community",
        manifests: [
          ...entry.manifests,
          {
            runtime: {},
            manifest: { ...TEST_MANIFEST, name: "test-plugin/unrelated" },
            promptTemplate: "Unrelated runtime must not require approval here",
            rawFrontmatter: {},
          },
        ],
      });
      const load = vi.spyOn(deps, "loadRuntimeFn");
      const claim = vi.spyOn(store, "claimSuspension");
      await createSuspension(store);
      const app = createTestApp(deps);
      const resume = (data: unknown = { name: "Alice" }) =>
        app.request("/api/sessions/sess-1/suspensions/susp-1/resume", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ data }),
        });
      for (const action of [
        COMMUNITY_SERVER_CODE_ACTION,
        "runtime:test-plugin",
      ]) {
        // Authorization precedes validation of the submitted form.
        const response = await resume({});
        expect(response.status).toBe(202);
        const body = await response.json();
        expect(body).toMatchObject({
          status: "approval-required",
          pending: { sessionId: "sess-1", pluginId: "test-plugin", action },
        });
        expect(claim).not.toHaveBeenCalled();
        expect(load).not.toHaveBeenCalled();
        expect(
          (await store.getSuspension("susp-1"))?.resolvedAt,
        ).toBeUndefined();
        const session = await store.getSession("sess-1");
        expect(
          gate.decide(
            {
              approvalId: body.approvalId,
              decision: "allow",
              scope: "session",
              decidedAt: new Date().toISOString(),
            },
            sessionApprovalScope(session!, "test-plugin"),
          ),
        ).toMatchObject({ ok: true });
      }
      expect((await resume()).status).toBe(200);
      expect(load).toHaveBeenCalledOnce();
      expect(claim).toHaveBeenCalledOnce();
    });

    it("rechecks revoked grants under the session lock, including manual continuations", async () => {
      const gate = createRpcApprovalGate();
      const deps = makeDefaultDeps(store, { rpcApprovalGate: gate });
      const entry = deps.pluginRegistry.get("test-plugin");
      if (!entry?.manifests) throw new Error("expected fixture runtimes");
      deps.pluginRegistry.register({
        ...entry,
        source: "community",
        manifests: entry.manifests.map((record) => ({
          ...record,
          manifest: {
            ...record.manifest,
            trigger: { type: "manual" },
            stage: undefined,
          },
        })),
      });
      const scope = sessionApprovalScope(
        (await store.getSession("sess-1"))!,
        "test-plugin",
      );
      for (const action of [
        COMMUNITY_SERVER_CODE_ACTION,
        "runtime:test-plugin",
      ]) {
        const verdict = gate.evaluate({
          sessionId: "sess-1",
          sessionScope: scope,
          pluginId: "test-plugin",
          action,
          payload: {},
          trustLevel: "community",
        });
        if (verdict.status !== "pending")
          throw new Error("expected pending approval");
        gate.decide(
          {
            approvalId: verdict.approvalId,
            decision: "allow",
            scope: "session",
            decidedAt: new Date().toISOString(),
          },
          scope,
        );
      }
      const lock = createInProcessSessionLock();
      const withLock = lock.withLock.bind(lock);
      vi.spyOn(lock, "withLock").mockImplementationOnce((sid, fn) =>
        withLock(sid, async () => {
          gate.revoke(sid);
          return fn();
        }),
      );
      const claim = vi.spyOn(store, "claimSuspension");
      const load = vi.spyOn(deps, "loadRuntimeFn");
      await createSuspension(store);
      const response = await createTestApp(deps, lock).request(
        "/api/sessions/sess-1/suspensions/susp-1/resume",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ data: { name: "Alice" } }),
        },
      );
      expect(response.status).toBe(202);
      expect(await response.json()).toMatchObject({
        status: "approval-required",
        pending: { action: COMMUNITY_SERVER_CODE_ACTION },
      });
      expect(claim).not.toHaveBeenCalled();
      expect(load).not.toHaveBeenCalled();
    });

    it.each(["before lock", "under lock"])(
      "refuses an invalid resume schema %s without claiming or loading",
      async (when) => {
        vi.spyOn(console, "warn").mockImplementation(() => {});
        const invalid = { type: "not-a-json-schema-type" };
        const suspension = await createSuspension(
          store,
          when === "before lock" ? { resumeSchema: invalid } : undefined,
        );
        const lock = createInProcessSessionLock();
        if (when === "under lock") {
          const withLock = lock.withLock.bind(lock);
          vi.spyOn(lock, "withLock").mockImplementationOnce((sid, fn) =>
            withLock(sid, async () => {
              await store.saveSuspension({
                ...suspension,
                resumeSchema: invalid,
              });
              return fn();
            }),
          );
        }
        const deps = makeDefaultDeps(store);
        const claim = vi.spyOn(store, "claimSuspension");
        const load = vi.spyOn(deps, "loadRuntimeFn");
        const response = await createTestApp(deps, lock).request(
          "/api/sessions/sess-1/suspensions/susp-1/resume",
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ data: { name: "Alice" } }),
          },
        );
        expect(response.status).toBe(400);
        expect(await response.json()).toMatchObject({
          code: "resume_schema_invalid",
        });
        expect(claim).not.toHaveBeenCalled();
        expect(load).not.toHaveBeenCalled();
        expect(
          (await store.getSuspension("susp-1"))?.resolvedAt,
        ).toBeUndefined();
      },
    );

    it.each(["acquire", "claimed", "unknown"])(
      "classifies %s failures without losing retryability",
      async (seam) => {
        vi.stubEnv("NODE_ENV", "production");
        const log = vi
          .spyOn(console, seam === "unknown" ? "error" : "warn")
          .mockImplementation(() => {});
        const marker = "INTERNAL_RESUME_DIAGNOSTIC";
        const failure =
          seam === "unknown"
            ? new Error(marker)
            : new SessionLockTimeoutError(marker);
        await createSuspension(store);
        const lock = createInProcessSessionLock();
        const claim = vi.spyOn(store, "claimSuspension");
        const prepare = vi.fn(async () => {});
        if (seam === "acquire")
          vi.spyOn(lock, "withLock").mockRejectedValueOnce(failure);
        else prepare.mockRejectedValueOnce(failure);
        const app = createTestApp(
          makeDefaultDeps(store, { prepareToolsForSession: prepare }),
          lock,
        );
        const resume = () =>
          app.request("/api/sessions/sess-1/suspensions/susp-1/resume", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ data: { name: "Alice" } }),
          });
        const response = await resume();
        expect(response.status).toBe(seam === "unknown" ? 500 : 503);
        expect(await response.json()).toEqual(
          seam === "unknown"
            ? { error: "Internal server error" }
            : { error: "Session is busy, please retry", code: "session_busy" },
        );
        expect(log.mock.calls.flat().join(" ")).toContain(marker);
        expect(claim).toHaveBeenCalledTimes(seam === "acquire" ? 0 : 1);
        expect(
          (await store.getSuspension("susp-1"))?.resolvedAt,
        ).toBeUndefined();
        expect((await resume()).status).toBe(200);
      },
    );

    it("does not release a claim that another resume took after the stale-claim sweep", async () => {
      vi.spyOn(console, "error").mockImplementation(() => {});
      await createSuspension(store);
      let otherClaim: string | null = null;
      // While this resume is in flight the sweep releases its claim as stale
      // and a second resume claims the suspension. Then this resume fails.
      vi.useFakeTimers({ toFake: ["Date"] });
      const prepare = vi.fn(async () => {
        vi.setSystemTime(Date.now() + 2 * 60 * 60_000);
        await store.releaseStaleSuspensionClaims(
          new Date(Date.now() - 60 * 60_000).toISOString(),
        );
        otherClaim = await store.claimSuspension("susp-1");
        throw new Error("first resume failed");
      });
      const app = createTestApp(
        makeDefaultDeps(store, { prepareToolsForSession: prepare }),
      );

      let response: Response;
      try {
        response = await app.request(
          "/api/sessions/sess-1/suspensions/susp-1/resume",
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ data: { name: "Alice" } }),
          },
        );
      } finally {
        vi.useRealTimers();
      }

      expect(response.status).toBe(500);
      expect(otherClaim).toMatch(/^claimed:/);
      expect((await store.getSuspension("susp-1"))?.resolvedAt).toBe(
        otherClaim,
      );
    });

    it("uses the server-configured adapter when X-Provider-Keys is missing", async () => {
      const app = createTestApp(makeDefaultDeps(store));
      await createSuspension(store);

      const res = await app.request(
        "/api/sessions/sess-1/suspensions/susp-1/resume",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            data: { name: "Alice" },
          }),
        },
      );

      expect(res.status).toBe(200);
    });

    it("threads player, world, and manifest settings to resumed runtime hooks", async () => {
      const worldId = `settings-world-${crypto.randomUUID()}`;
      await setSessionWorld(store, "sess-1", worldId);
      await store.upsertWorld({
        id: worldId,
        name: "Test world",
        description: "",
        metadata: {
          pluginSettings: { "test-plugin": { tone: "world", detail: 2 } },
        },
        createdAt: new Date().toISOString(),
      });
      await createSuspension(store);
      const hookPipeline = createHookPipeline();
      let hookSettings: unknown;
      const commitSettings: unknown[] = [];
      for (const event of ["PreStateCommit", "PostStateCommit"] as const) {
        hookPipeline.register({
          id: `test-plugin:${event}:settings`,
          event,
          pluginId: "test-plugin",
          handler: async (ctx) => {
            commitSettings.push(ctx.getOwnSettings?.());
            return { action: "continue" };
          },
        });
      }
      // PreRuntime ran when the runtime was first dispatched; the resumed run
      // ends with PostRuntime, which reads the settings of this request.
      hookPipeline.register({
        id: "test-plugin:PostRuntime:settings",
        event: "PostRuntime",
        pluginId: "test-plugin",
        handler: async (ctx) => {
          hookSettings = ctx.getOwnSettings?.();
          return { action: "continue" };
        },
      });
      const app = createTestApp(makeDefaultDeps(store, { hookPipeline }));
      const playerSettings = Buffer.from(
        JSON.stringify({ "test-plugin": { tone: "player" } }),
        "utf8",
      ).toString("base64");

      const res = await app.request(
        "/api/sessions/sess-1/suspensions/susp-1/resume",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Plugin-User-Settings": playerSettings,
          },
          body: JSON.stringify({
            data: { name: "Alice" },
          }),
        },
      );

      expect(res.status).toBe(200);
      expect(hookSettings).toEqual({
        tone: "player",
        detail: 2,
        fallback: "manifest-only",
      });
      expect(commitSettings.length).toBeGreaterThanOrEqual(2);
      expect(commitSettings.every((value) => value === hookSettings)).toBe(
        true,
      );
      const capturedHookSettings = hookSettings;
      const currentWorld = (await store.getWorld(worldId))!;
      await store.upsertWorld({
        ...currentWorld,
        metadata: {
          pluginSettings: {
            "test-plugin": { tone: "updated-world", detail: 3 },
          },
        },
      });
      await createSuspension(store, { id: "susp-2" });
      const next = await app.request(
        "/api/sessions/sess-1/suspensions/susp-2/resume",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ data: { name: "Bob" } }),
        },
      );
      expect(next.status).toBe(200);
      expect(hookSettings).toEqual({
        tone: "updated-world",
        detail: 3,
        fallback: "manifest-only",
      });
      expect(capturedHookSettings).toEqual({
        tone: "player",
        detail: 2,
        fallback: "manifest-only",
      });
    });

    it("restores persisted plugin activations before scoping resume hooks", async () => {
      // The plugin is persisted on the session but not yet activated in this
      // fresh process-local registry. Resume must restore it before building
      // the hook scope.
      const hookPipeline = createHookPipeline();
      const preToolUse = vi.fn().mockResolvedValue({ action: "continue" });
      hookPipeline.register({
        id: "test-plugin:PreToolUse",
        event: "PreToolUse",
        pluginId: "test-plugin",
        handler: preToolUse,
      });

      // First LLM response asks for a tool call (fires PreToolUse); the second
      // finalizes the runtime.
      let llmCalls = 0;
      const llmAdapter = {
        generate: async () => {
          llmCalls++;
          if (llmCalls === 1) {
            return {
              content: "",
              toolCalls: [{ id: "tc-1", name: "noop", arguments: "{}" }],
              finishReason: "tool_calls",
              usage: { inputTokens: 1, outputTokens: 1 },
            };
          }
          return {
            content: '{"narrativeOutput": "done"}',
            toolCalls: [],
            finishReason: "stop",
            usage: { inputTokens: 1, outputTokens: 1 },
          };
        },
      };

      await createSuspension(store);
      const app = createTestApp(
        makeDefaultDeps(store, { llmAdapter, hookPipeline }),
      );

      const res = await app.request(
        "/api/sessions/sess-1/suspensions/susp-1/resume",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Provider-Keys": "dGVzdA==",
          },
          body: JSON.stringify({
            data: { name: "Alice" },
          }),
        },
      );

      expect(res.status).toBe(200);
      // The resumed plugin's own PreToolUse hook fired — it was in hook scope.
      expect(preToolUse).toHaveBeenCalledTimes(1);
    });

    it("does not reactivate a plugin disabled after suspension", async () => {
      await createSuspension(store);
      await store.updateSession("sess-1", { activePlugins: [] });
      const deps = makeDefaultDeps(store);
      deps.pluginRegistry.syncSessionActivations("sess-1", ["test-plugin"]);
      const app = createTestApp(deps);

      const res = await app.request(
        "/api/sessions/sess-1/suspensions/susp-1/resume",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Provider-Keys": "dGVzdA==",
          },
          body: JSON.stringify({
            data: { name: "Alice" },
          }),
        },
      );

      expect(res.status).toBe(404);
      expect(deps.pluginRegistry.getActiveRuntimes("sess-1")).toEqual([]);
    });

    it("returns 400 when body is not valid JSON", async () => {
      const app = createTestApp(makeDefaultDeps(store));

      const res = await app.request(
        "/api/sessions/sess-1/suspensions/susp-1/resume",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Provider-Keys": "dGVzdA==",
          },
          body: "not-json",
        },
      );

      expect(res.status).toBe(400);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body.error).toMatch(/JSON/i);
    });

    it("returns 400 when the body shape is invalid", async () => {
      const app = createTestApp(makeDefaultDeps(store));

      const res = await app.request(
        "/api/sessions/sess-1/suspensions/susp-1/resume",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Provider-Keys": "dGVzdA==",
          },
          body: JSON.stringify({ data: { name: "Alice" }, extra: true }),
        },
      );

      expect(res.status).toBe(400);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body.code).toBe("invalid_request_body");
    });

    it("returns 404 when session does not exist", async () => {
      const app = createTestApp(makeDefaultDeps(store));
      await createSuspension(store, { sessionId: "sess-1" });

      const res = await app.request(
        "/api/sessions/sess-nonexistent/suspensions/susp-1/resume",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Provider-Keys": "dGVzdA==",
          },
          body: JSON.stringify({
            data: { name: "Alice" },
          }),
        },
      );

      expect(res.status).toBe(404);
    });

    it("returns 404 when suspension does not exist", async () => {
      const app = createTestApp(makeDefaultDeps(store));

      const res = await app.request(
        "/api/sessions/sess-1/suspensions/nonexistent-susp/resume",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Provider-Keys": "dGVzdA==",
          },
          body: JSON.stringify({
            data: { name: "Alice" },
          }),
        },
      );

      expect(res.status).toBe(404);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body.error).toMatch(/not found/i);
    });

    it("returns 404 when suspension belongs to a different session", async () => {
      // Create suspension for sess-other
      await createSession(store, "sess-other");
      await createSuspension(store, {
        id: "susp-other",
        sessionId: "sess-other",
      });
      const app = createTestApp(makeDefaultDeps(store));

      const res = await app.request(
        "/api/sessions/sess-1/suspensions/susp-other/resume",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Provider-Keys": "dGVzdA==",
          },
          body: JSON.stringify({
            data: { name: "Alice" },
          }),
        },
      );

      expect(res.status).toBe(404);
    });

    it("returns 409 when suspension is already resolved (idempotency)", async () => {
      await createSuspension(store, { resolvedAt: new Date().toISOString() });
      const app = createTestApp(makeDefaultDeps(store));

      const res = await app.request(
        "/api/sessions/sess-1/suspensions/susp-1/resume",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Provider-Keys": "dGVzdA==",
          },
          body: JSON.stringify({
            data: { name: "Alice" },
          }),
        },
      );

      // 409 Conflict: the resolved-already check and the atomic claim both
      // reject with "already resolved" — 409 distinguishes this from the
      // other 404 "not found" paths that cover missing sessions/suspensions.
      expect(res.status).toBe(409);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body.error).toMatch(/already resolved/i);
    });

    it("returns 400 when resume data fails schema validation", async () => {
      await createSuspension(store);
      const app = createTestApp(makeDefaultDeps(store));

      // Schema requires { name: string } but we pass { count: 42 }
      const res = await app.request(
        "/api/sessions/sess-1/suspensions/susp-1/resume",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Provider-Keys": "dGVzdA==",
          },
          body: JSON.stringify({ data: { count: 42 } }),
        },
      );

      expect(res.status).toBe(400);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body.error).toMatch(/validation/i);
    });

    it("returns 400 when resume data has wrong field type", async () => {
      await createSuspension(store, {
        resumeSchema: {
          type: "object",
          properties: { age: { type: "number" } },
        },
      });
      const app = createTestApp(makeDefaultDeps(store));

      const res = await app.request(
        "/api/sessions/sess-1/suspensions/susp-1/resume",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Provider-Keys": "dGVzdA==",
          },
          body: JSON.stringify({
            data: { age: "not-a-number" },
          }),
        },
      );

      expect(res.status).toBe(400);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body.error).toMatch(/validation/i);
    });

    it("applies the current context budget before resuming the provider call", async () => {
      await createSuspension(store);
      const generate = vi.fn(makeDefaultLLM().generate);
      const app = createTestApp(
        makeDefaultDeps(store, {
          llmAdapter: { generate },
          // One token for the input: no request fits, whatever the system
          // prompt and the tool definitions come to.
          contextBudget: { maxInputTokens: 41, reservedForResponse: 40 },
        }),
      );
      const res = await app.request(
        "/api/sessions/sess-1/suspensions/susp-1/resume",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            data: { name: "resume-context".repeat(100) },
          }),
        },
      );
      expect(res.status).toBe(500);
      expect((await res.json()).error).toContain("Context budget exceeded");
      expect(generate).not.toHaveBeenCalled();
      expect((await store.getSuspension("susp-1"))?.resolvedAt).toBeUndefined();
    });

    it("releases a failed execution claim and retries the same suspension", async () => {
      vi.stubEnv("NODE_ENV", "production");
      const log = vi.spyOn(console, "error").mockImplementation(() => {});
      await createSuspension(store);
      const hookPipeline = createHookPipeline();
      const postRuntime = vi.fn(async () => ({ action: "continue" as const }));
      hookPipeline.register({
        id: "resume-terminal",
        event: "PostRuntime",
        handler: postRuntime,
      });
      const generate = vi.fn(makeDefaultLLM().generate);
      generate.mockRejectedValueOnce(new Error("synthetic provider failure"));
      const app = createTestApp(
        makeDefaultDeps(store, { llmAdapter: { generate }, hookPipeline }),
      );
      const resume = () =>
        app.request("/api/sessions/sess-1/suspensions/susp-1/resume", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ data: { name: "Alice" } }),
        });

      const failed = await resume();
      expect(failed.status).toBe(500);
      // The runtime's failure is named, as a turn names it to the player;
      // the runtime result itself is not returned.
      const failure = (await failed.json()) as Record<string, unknown>;
      expect(Object.keys(failure)).toEqual(["error"]);
      expect(failure.error).toMatch(
        /^Resume failed: .*synthetic provider failure/,
      );
      expect(log.mock.calls.flat().join(" ")).toContain(
        "synthetic provider failure",
      );
      expect(postRuntime).toHaveBeenCalledTimes(1);
      expect((await store.getSuspension("susp-1"))?.resolvedAt).toBeUndefined();

      expect((await resume()).status).toBe(200);
      expect(postRuntime).toHaveBeenCalledTimes(2);
      expect((await store.getSuspension("susp-1"))?.resolvedAt).toBeDefined();
    });

    it("returns 200 with result on successful resume", async () => {
      await createSuspension(store);
      const app = createTestApp(makeDefaultDeps(store));

      const res = await app.request(
        "/api/sessions/sess-1/suspensions/susp-1/resume",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Provider-Keys": "dGVzdA==",
          },
          body: JSON.stringify({
            data: { name: "Alice" },
          }),
        },
      );

      expect(res.status).toBe(200);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body.result).toBeDefined();
      expect((body.result as Record<string, unknown>).status).toBe("success");
      expect(body.events).toBeDefined();
      expect(body.events).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ type: "narrative.completed" }),
        ]),
      );
    });

    it("completes the inherited logical player turn exactly once on resume", async () => {
      await store.updateSession("sess-1", {
        phase: "playing",
        completedPlayerTurns: 1,
      });
      await createSuspension(store, {
        executionContext: {
          executionId: "execution-before-suspend",
          origin: "player",
          logicalTurnId: "logical-suspended-turn",
          countPolicy: "complete-player-turn",
        },
      });
      const app = createTestApp(makeDefaultDeps(store));

      const resume = () =>
        app.request("/api/sessions/sess-1/suspensions/susp-1/resume", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Provider-Keys": "dGVzdA==",
          },
          body: JSON.stringify({
            data: { name: "Alice" },
          }),
        });

      expect((await resume()).status).toBe(200);
      expect((await store.getSession("sess-1"))?.completedPlayerTurns).toBe(2);
      expect((await resume()).status).toBe(409);
      expect((await store.getSession("sess-1"))?.completedPlayerTurns).toBe(2);
    });

    it("returns a resumed runtime that suspends again as suspended, under a new id", async () => {
      await store.updateSession("sess-1", {
        phase: "playing",
        completedPlayerTurns: 1,
      });
      await createSuspension(store, { withheldRuntimeJobs: [heldBackJob()] });
      let replies = 0;
      const app = createTestApp(
        makeDefaultDeps(
          store,
          {
            llmAdapter: {
              generate: async () =>
                ++replies === 1
                  ? {
                      content: null,
                      toolCalls: [
                        {
                          id: "tc-suspend-2",
                          name: "suspend",
                          arguments: JSON.stringify({
                            reason: "Need a surname too",
                            resumeSchema: {
                              type: "object",
                              properties: { surname: { type: "string" } },
                              required: ["surname"],
                            },
                          }),
                        },
                      ],
                      finishReason: "tool_calls",
                      usage: { inputTokens: 5, outputTokens: 5 },
                    }
                  : {
                      content: '{"narrativeOutput": "Resume complete."}',
                      toolCalls: [],
                      finishReason: "stop",
                      usage: { inputTokens: 5, outputTokens: 5 },
                    },
            },
            // The real executor, so the builtin suspend tool runs as usual.
            toolExecutor: createToolExecutor({
              findTool: (name) =>
                name === suspendTool.name ? suspendTool : undefined,
            }) as never,
          },
          { ...TEST_MANIFEST, tools: { builtin: ["suspend"] } },
          [HELD_BACK_MANIFEST],
        ),
      );
      const resume = (id: string, data: Record<string, string>) =>
        app.request(`/api/sessions/sess-1/suspensions/${id}/resume`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Provider-Keys": "dGVzdA==",
          },
          body: JSON.stringify({ data }),
        });
      const openIds = async () => {
        const res = await app.request("/api/sessions/sess-1/suspensions");
        const body = (await res.json()) as { items: { id: string }[] };
        return body.items.map((item) => item.id);
      };

      const first = await resume("susp-1", { name: "Alice" });
      expect(first.status).toBe(200);
      const firstBody = (await first.json()) as {
        result: { status: string; output?: { suspensionId?: string } };
      };
      expect(firstBody.result.status).toBe("suspended");
      const nextId = firstBody.result.output?.suspensionId;
      expect(nextId).toBeDefined();
      expect(nextId).not.toBe("susp-1");
      expect(await openIds()).toEqual([nextId]);
      // The logical turn is still open while the runtime waits again, and
      // the job it held back stays held back with the new record.
      expect((await store.getSession("sess-1"))?.completedPlayerTurns).toBe(1);
      expect(await listRuntimeJobs(store, { sessionId: "sess-1" })).toEqual([]);
      expect(
        (await store.getSuspension(nextId!))?.pendingContinuation
          .withheldRuntimeJobs,
      ).toEqual([heldBackJob()]);

      const stale = await resume("susp-1", { name: "Alice" });
      expect(stale.status).toBe(409);
      expect(await stale.text()).toContain("already resolved");

      const second = await resume(nextId!, { surname: "Liddell" });
      expect(second.status).toBe(200);
      const secondBody = (await second.json()) as {
        result: { status: string };
      };
      expect(secondBody.result.status).toBe("success");
      expect(await openIds()).toEqual([]);
      expect((await store.getSession("sess-1"))?.completedPlayerTurns).toBe(2);
      expect(
        (await listRuntimeJobs(store, { sessionId: "sess-1" })).map(
          (job) => job.jobId,
        ),
      ).toEqual(["held-back-job"]);
    });

    it("queues a function chain's held-back job once, when the chain ends", async () => {
      await store.updateSession("sess-1", {
        phase: "playing",
        completedPlayerTurns: 1,
      });
      await createSuspension(store, { withheldRuntimeJobs: [heldBackJob()] });
      const asker: RuntimeManifest = {
        ...TEST_MANIFEST,
        runtimeType: "function",
        outputKind: "system",
      };
      const handler: FunctionHandler = async (ctx) =>
        ctx.resumedFromSuspensionId === "susp-1"
          ? {
              outcome: "suspended",
              reason: "Need a surname too",
              resumeSchema: {
                type: "object",
                properties: { surname: { type: "string" } },
                required: ["surname"],
              },
            }
          : { outcome: "success", value: { content: "Answered." } };
      const app = createTestApp(
        makeDefaultDeps(
          store,
          {
            loadRuntimeFn: async () =>
              ({ manifest: asker, promptTemplate: "", handler }) as never,
          },
          asker,
          [HELD_BACK_MANIFEST],
        ),
      );
      const resume = (id: string, data: Record<string, string>) =>
        app.request(`/api/sessions/sess-1/suspensions/${id}/resume`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Provider-Keys": "dGVzdA==",
          },
          body: JSON.stringify({ data }),
        });
      const queued = async () =>
        (await listRuntimeJobs(store, { sessionId: "sess-1" })).map(
          (job) => job.jobId,
        );

      const first = await resume("susp-1", { name: "Alice" });
      expect(first.status).toBe(200);
      const firstBody = (await first.json()) as {
        result: { status: string; output?: { suspensionId?: string } };
      };
      expect(firstBody.result.status).toBe("suspended");
      const nextId = firstBody.result.output?.suspensionId;
      expect(nextId).toBeDefined();
      expect(await queued()).toEqual([]);
      expect((await store.getSession("sess-1"))?.completedPlayerTurns).toBe(1);

      const second = await resume(nextId!, { surname: "Liddell" });
      expect(second.status).toBe(200);
      expect(
        ((await second.json()) as { result: { status: string } }).result.status,
      ).toBe("success");
      expect(await queued()).toEqual(["held-back-job"]);
      expect((await store.getSession("sess-1"))?.completedPlayerTurns).toBe(2);
    });

    it("waits for the final sibling suspension before completing the logical turn", async () => {
      await store.updateSession("sess-1", {
        phase: "playing",
        completedPlayerTurns: 1,
      });
      const executionContext: ExecutionContext = {
        executionId: "parallel-execution",
        origin: "player",
        logicalTurnId: "logical-parallel-suspensions",
        countPolicy: "complete-player-turn",
      };
      const deps = makeDefaultDeps(store);
      const entry = deps.pluginRegistry.get("test-plugin");
      if (!entry?.manifests) throw new Error("expected fixture runtimes");
      const siblingRuntimeId = "test-plugin/sibling";
      deps.pluginRegistry.register({
        ...entry,
        manifests: [
          ...entry.manifests,
          {
            runtime: {},
            manifest: { ...TEST_MANIFEST, name: siblingRuntimeId },
            promptTemplate: "Sibling runtime",
            rawFrontmatter: {},
          },
        ],
      });
      // Parallel siblings belong to different runtimes. A newer suspension
      // of the same runtime would correctly supersede the first one.
      await createSuspension(store, {
        id: "susp-a",
        executionContext,
        createdAt: "2026-10-14T00:00:00.000Z",
      });
      await createSuspension(store, {
        id: "susp-b",
        runtimeId: siblingRuntimeId,
        executionContext,
        createdAt: "2026-10-14T00:00:00.001Z",
      });
      const app = createTestApp(deps);
      const resume = (suspensionId: string) =>
        app.request(`/api/sessions/sess-1/suspensions/${suspensionId}/resume`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Provider-Keys": "dGVzdA==",
          },
          body: JSON.stringify({ data: { name: "Alice" } }),
        });

      expect((await resume("susp-a")).status).toBe(200);
      expect((await store.getSession("sess-1"))?.completedPlayerTurns).toBe(1);
      expect((await resume("susp-b")).status).toBe(200);
      expect((await store.getSession("sess-1"))?.completedPlayerTurns).toBe(2);
    });

    it("buffers post-commit fan-out until the finalize transaction commits: a rollback leaves hooks unobserved", async () => {
      vi.stubEnv("NODE_ENV", "production");
      const log = vi.spyOn(console, "error").mockImplementation(() => {});
      // Proposals commit through the tx-bound store view inside the route's
      // finalize transaction. If a LATER write in that transaction throws
      // (here: markSuspensionResolved), the whole transaction rolls back —
      // so PostStateCommit must never have fired for the rolled-back
      // proposals. The transaction-bound commit path must defer fan-out while
      // the outer transaction is still open.
      const hookPipeline = createHookPipeline();
      const postStateCommit = vi.fn().mockResolvedValue({ action: "continue" });
      hookPipeline.register({
        id: "test-plugin:PostStateCommit",
        event: "PostStateCommit",
        pluginId: "test-plugin",
        handler: postStateCommit,
      });

      await createSuspension(store);
      // Fail the finalize step AFTER the proposal commits, inside the same
      // transaction. The tx scope comes from the real store, so the override
      // must wrap withTransaction and patch the scope it hands out.
      const failingStore = {
        ...store,
        withTransaction: <T>(
          fn: (tx: import("@covel/store").StoreTransaction) => Promise<T>,
        ) =>
          store.withTransaction!((tx) =>
            fn({
              ...tx,
              markSuspensionResolved: async () => {
                throw new Error("forced finalize failure");
              },
            }),
          ),
      } as DataStore;
      const app = createTestApp(
        makeDefaultDeps(failingStore, { hookPipeline }),
      );

      const res = await app.request(
        "/api/sessions/sess-1/suspensions/susp-1/resume",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Provider-Keys": "dGVzdA==",
          },
          body: JSON.stringify({
            data: { name: "Alice" },
          }),
        },
      );

      expect(res.status).toBe(500);
      const body = (await res.json()) as Record<string, unknown>;
      expect(Object.keys(body)).toEqual(["error"]);
      expect(body.error).toMatch(
        /^Resume commit failed: .*forced finalize failure.*can be retried\.$/,
      );
      expect(log.mock.calls.flat().join(" ")).toContain(
        "forced finalize failure",
      );
      expect((await store.getSuspension("susp-1"))?.resolvedAt).toBeUndefined();

      // The rollback undid the narrative write…
      const messages = await store.listMessages("sess-1");
      expect(messages.map((m) => m.content)).not.toContain("Resume complete.");
      // …and no hook ever observed a "committed" state for it.
      expect(postStateCommit).not.toHaveBeenCalled();
      const retryApp = createTestApp(makeDefaultDeps(store, { hookPipeline }));
      const retry = await retryApp.request(
        "/api/sessions/sess-1/suspensions/susp-1/resume",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ data: { name: "Alice" } }),
        },
      );
      expect(retry.status).toBe(200);
      expect((await store.getSuspension("susp-1"))?.resolvedAt).toBeDefined();
      expect((await store.getSession("sess-1"))?.completedPlayerTurns).toBe(2);
    });

    it("does not restore a claimed suspension into a recreated session after failure", async () => {
      await store.updateSession("sess-1", {
        metadata: {
          approvalScopeNonce: globalThis.crypto.randomUUID(),
          [SESSION_INCARNATION_KEY]: "old-incarnation",
        },
      });
      await createSuspension(store);
      const sessionLock = createInProcessSessionLock();
      let enteredPrepare!: () => void;
      const prepareStarted = new Promise<void>((resolve) => {
        enteredPrepare = resolve;
      });
      let failPrepare!: () => void;
      const continuePrepare = new Promise<void>((resolve) => {
        failPrepare = resolve;
      });
      const app = createTestApp(
        makeDefaultDeps(store, {
          prepareToolsForSession: async () => {
            enteredPrepare();
            await continuePrepare;
            throw new Error("forced preparation failure");
          },
        }),
        sessionLock,
      );

      const request = app.request(
        "/api/sessions/sess-1/suspensions/susp-1/resume",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Provider-Keys": "dGVzdA==",
          },
          body: JSON.stringify({
            data: { name: "Alice" },
          }),
        },
      );
      await prepareStarted;

      // Queue delete/recreate behind the in-flight resume. Its slot is ahead
      // of the catch-path claim release, reproducing the ABA ordering that
      // previously restored the old suspension into the new incarnation.
      const replace = sessionLock.withLock("sess-1", async () => {
        await store.deleteSession("sess-1");
        const now = new Date().toISOString();
        await store.createSession({
          locale: "zh-CN",
          phase: "playing",
          setupRuntimes: {},
          seats: [
            {
              id: "main",
              controller: "human",
              role: "player",
              characters: "auto",
            },
          ],
          id: "sess-1",
          worldId: "test-world",
          status: "active",
          completedPlayerTurns: 0,

          activePlugins: [],
          metadata: {
            approvalScopeNonce: globalThis.crypto.randomUUID(),
            [SESSION_INCARNATION_KEY]: "new-incarnation",
          },
          createdAt: now,
          updatedAt: now,
        });
      });
      failPrepare();

      await replace;
      const res = await request;
      expect(res.status).toBe(500);
      expect(await store.getSuspension("susp-1")).toBeNull();
      expect(
        (await store.getSession("sess-1"))?.metadata?.[SESSION_INCARNATION_KEY],
      ).toBe("new-incarnation");
    });

    it("commits resumed runtime output to the store before returning", async () => {
      await createSuspension(store);
      const app = createTestApp(makeDefaultDeps(store));

      const res = await app.request(
        "/api/sessions/sess-1/suspensions/susp-1/resume",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Provider-Keys": "dGVzdA==",
          },
          body: JSON.stringify({
            data: { name: "Alice" },
          }),
        },
      );

      expect(res.status).toBe(200);

      const messages = await store.listMessages("sess-1");
      expect(messages).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            content: "Resume complete.",
            role: "assistant",
          }),
        ]),
      );
    });
  });

  describe("DELETE /api/sessions/:id/suspensions/:suspensionId", () => {
    it("returns 404 when suspension does not exist", async () => {
      const app = createTestApp(makeDefaultDeps(store));

      const res = await app.request(
        "/api/sessions/sess-1/suspensions/nonexistent",
        {
          method: "DELETE",
        },
      );

      expect(res.status).toBe(404);
    });

    it("returns 200 with ok: true when suspension is removed", async () => {
      await createSuspension(store);
      const app = createTestApp(makeDefaultDeps(store));

      const res = await app.request("/api/sessions/sess-1/suspensions/susp-1", {
        method: "DELETE",
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body.ok).toBe(true);
      expect(body.suspensionId).toBe("susp-1");
    });

    it("removes suspension from store after deletion", async () => {
      await createSuspension(store);
      const app = createTestApp(makeDefaultDeps(store));

      await app.request("/api/sessions/sess-1/suspensions/susp-1", {
        method: "DELETE",
      });

      const retrieved = await store.getSuspension("susp-1");
      expect(retrieved).toBeNull();
    });

    it("ends a suspended setup attempt as failed so the runtime can be retried or skipped (F-188)", async () => {
      const executionContext = {
        executionId: "execution-setup",
        origin: "player" as const,
        countPolicy: "complete-player-turn" as const,
        logicalTurnId: "logical-setup",
      };
      await createSuspension(store, { executionContext });
      await store.insertSetupAttempt({
        sessionId: "sess-1",
        runtimeId: "test-plugin",
        pluginVersion: "0.0.0",
        generation: 1,
        executionId: "execution-setup",
        state: "suspended",
        startedAt: new Date().toISOString(),
      });
      await store.updateSession("sess-1", {
        setupRuntimes: {
          "test-plugin": {
            state: "pending",
            pluginVersion: "0.0.0",
            generation: 1,
            attempts: 0,
          },
        },
      });
      const app = createTestApp(makeDefaultDeps(store));

      const res = await app.request("/api/sessions/sess-1/suspensions/susp-1", {
        method: "DELETE",
      });

      expect(res.status).toBe(200);
      const attempts = await store.listSetupAttempts("sess-1", {
        runtimeId: "test-plugin",
      });
      expect(attempts.map((attempt) => attempt.state)).toEqual(["failed"]);
      expect(
        (await store.getSession("sess-1"))?.setupRuntimes["test-plugin"],
      ).toMatchObject({ state: "pending", attempts: 1 });
    });

    it("ends the turn when the abandoned suspension was its last pending one (F-015)", async () => {
      const logicalTurnId = "logical-abandoned";
      const executionContext = {
        executionId: "execution-abandoned",
        origin: "player" as const,
        countPolicy: "complete-player-turn" as const,
        logicalTurnId,
      };
      await createSuspension(store, { id: "susp-a", executionContext });
      await createSuspension(store, { id: "susp-b", executionContext });
      const app = createTestApp(makeDefaultDeps(store));

      // A sibling still waits: the turn is not over yet.
      await app.request("/api/sessions/sess-1/suspensions/susp-a", {
        method: "DELETE",
      });
      expect((await store.getSession("sess-1"))?.completedPlayerTurns).toBe(1);

      await app.request("/api/sessions/sess-1/suspensions/susp-b", {
        method: "DELETE",
      });
      expect((await store.getSession("sess-1"))?.completedPlayerTurns).toBe(2);
      expect(
        await store.getLogicalTurnCompletion("sess-1", logicalTurnId),
      ).not.toBeNull();
    });
  });

  describe("resuming an out-of-date suspension (F-016, F-188)", () => {
    async function resumeOutdated(app: ReturnType<typeof createTestApp>) {
      const res = await app.request(
        "/api/sessions/sess-1/suspensions/susp-1/resume",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ data: { name: "Ada" } }),
        },
      );
      return {
        status: res.status,
        body: (await res.json()) as {
          code?: string;
          details?: { reason?: string };
        },
      };
    }

    it("voids a suspension taken under another plugin version and tells the player", async () => {
      await createSuspension(store, {
        takenUnder: { playerTurns: 0, pluginVersion: "0.9.0", writes: [] },
      });
      const generate = vi.fn();
      const app = createTestApp(
        makeDefaultDeps(store, { llmAdapter: { generate } as never }),
      );

      const { status, body } = await resumeOutdated(app);

      expect(status).toBe(409);
      expect(body.code).toBe("suspension_outdated");
      expect(body.details?.reason).toBe("plugin-updated");
      expect(generate).not.toHaveBeenCalled();
      // Voided like an abandon: the record is gone and the turn is over.
      expect(await store.getSuspension("susp-1")).toBeNull();
      expect((await store.getSession("sess-1"))?.completedPlayerTurns).toBe(2);
    });

    it("voids a suspension once the player has played another turn", async () => {
      await createSuspension(store);
      await store.appendTurnMessage({
        id: "later-player-message",
        sessionId: "sess-1",
        turnId: "turn-2",
        sourceType: "player",
        role: "user",
        content: "I keep walking.",
        order: 0,
        createdAt: new Date().toISOString(),
      });
      const app = createTestApp(makeDefaultDeps(store));

      const { status, body } = await resumeOutdated(app);

      expect(status).toBe(409);
      expect(body.details?.reason).toBe("session-moved-on");
      expect(await store.getSuspension("susp-1")).toBeNull();
    });

    describe("when a record its buffered writes target changed (F-016)", () => {
      const stageTarget = {
        kind: "plugin-data" as const,
        pluginId: "test-plugin",
        namespace: "quest",
        key: "stage",
      };
      const row = (key: string, value: unknown) => {
        const now = new Date().toISOString();
        return {
          id: `sess-1:test-plugin:quest:${key}`,
          sessionId: "sess-1",
          pluginId: "test-plugin",
          namespace: "quest",
          key,
          value,
          createdAt: now,
          updatedAt: now,
        };
      };
      /** A suspension whose continuation would write `quest/stage`. */
      async function suspensionWritingStage() {
        await store.setPluginData(row("stage", { step: "start" }));
        await createSuspension(store, {
          takenUnder: {
            playerTurns: 0,
            pluginVersion: "0.0.0",
            writes: [
              {
                target: stageTarget,
                digest: await readSuspensionWriteDigest(
                  store,
                  "sess-1",
                  stageTarget,
                ),
              },
            ],
          },
          pendingProposals: [
            {
              id: "buffered-stage",
              type: "plugin.data",
              source: { pluginId: "test-plugin", runtimeId: "test-plugin" },
              turnId: "turn-1",
              sessionId: "sess-1",
              payload: {
                namespace: "quest",
                key: "stage",
                value: { step: "asked" },
              },
              timestamp: new Date().toISOString(),
            },
          ],
        });
      }
      const stage = async () =>
        (await store.getPluginData("sess-1", "test-plugin", "quest", "stage"))
          ?.value;

      it("voids it after a background job wrote the same key, keeping that write", async () => {
        await suspensionWritingStage();
        // A detached job of an earlier turn commits after the suspension.
        await store.setPluginData(row("stage", { step: "background" }));
        const generate = vi.fn();
        const app = createTestApp(
          makeDefaultDeps(store, { llmAdapter: { generate } as never }),
        );

        const { status, body } = await resumeOutdated(app);

        expect(status).toBe(409);
        expect(body.code).toBe("suspension_outdated");
        expect(body.details?.reason).toBe("data-changed");
        expect(generate).not.toHaveBeenCalled();
        expect(await stage()).toEqual({ step: "background" });
        expect(await store.getSuspension("susp-1")).toBeNull();
      });

      it("voids it when the key changes while the continuation runs, committing nothing", async () => {
        await suspensionWritingStage();
        const generate = vi.fn(async () => {
          await store.setPluginData(row("stage", { step: "manual" }));
          return {
            content: '{"narrativeOutput": "Resume complete."}',
            toolCalls: [],
            finishReason: "stop",
            usage: { inputTokens: 5, outputTokens: 5 },
          };
        });
        const app = createTestApp(
          makeDefaultDeps(store, { llmAdapter: { generate } as never }),
        );

        const { status, body } = await resumeOutdated(app);

        expect(status).toBe(409);
        expect(body.details?.reason).toBe("data-changed");
        expect(generate).toHaveBeenCalled();
        expect(await stage()).toEqual({ step: "manual" });
        expect(await store.getSuspension("susp-1")).toBeNull();
        expect(await store.listMessages("sess-1")).not.toEqual(
          expect.arrayContaining([
            expect.objectContaining({ content: "Resume complete." }),
          ]),
        );
      });

      it("resumes when only another key changed", async () => {
        await suspensionWritingStage();
        await store.setPluginData(row("log", ["met the archivist"]));
        const app = createTestApp(makeDefaultDeps(store));

        const { status } = await resumeOutdated(app);

        expect(status).toBe(200);
        expect(await stage()).toEqual({ step: "asked" });
      });
    });

    it("returns 404 when suspension belongs to a different session", async () => {
      await createSession(store, "sess-other");
      await createSuspension(store, {
        id: "susp-other",
        sessionId: "sess-other",
      });
      const app = createTestApp(makeDefaultDeps(store));

      const res = await app.request(
        "/api/sessions/sess-1/suspensions/susp-other",
        {
          method: "DELETE",
        },
      );

      expect(res.status).toBe(404);
    });

    // This DELETE must enforce the session-owner guard
    // on hosted tiers like its sibling routes, not just a sessionId consistency
    // check. Anonymous deletion of another session's suspension is a
    // cross-tenant destructive write.
    it("denies anonymous suspension deletion on a hosted tier (owner guard)", async () => {
      const prevTier = process.env.DEPLOYMENT_TIER;
      const prevOp = process.env.COVEL_DESKTOP_REST_TOKEN;
      process.env.DEPLOYMENT_TIER = "commercial";
      process.env.COVEL_DESKTOP_REST_TOKEN = "operator-secret";
      try {
        await createSuspension(store);
        const app = createTestApp(makeDefaultDeps(store));

        const anon = await app.request(
          "/api/sessions/sess-1/suspensions/susp-1",
          { method: "DELETE" },
        );
        expect(anon.status).toBe(401);
        // The denied attempt must not have deleted the suspension.
        expect(await store.getSuspension("susp-1")).not.toBeNull();

        // The operator master credential passes the guard and deletes.
        const op = await app.request(
          "/api/sessions/sess-1/suspensions/susp-1",
          {
            method: "DELETE",
            headers: { authorization: "Bearer operator-secret" },
          },
        );
        expect(op.status).toBe(200);
      } finally {
        if (prevTier === undefined) delete process.env.DEPLOYMENT_TIER;
        else process.env.DEPLOYMENT_TIER = prevTier;
        if (prevOp === undefined) delete process.env.COVEL_DESKTOP_REST_TOKEN;
        else process.env.COVEL_DESKTOP_REST_TOKEN = prevOp;
      }
    });
  });

  describe("GET /api/sessions/:id/suspensions", () => {
    it("returns empty array when no suspensions exist", async () => {
      const app = createTestApp(makeDefaultDeps(store));

      const res = await app.request("/api/sessions/sess-1/suspensions");

      expect(res.status).toBe(200);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body.items).toEqual([]);
    });

    it("returns 404 when session does not exist", async () => {
      const app = createTestApp(makeDefaultDeps(store));

      const res = await app.request("/api/sessions/sess-missing/suspensions");

      expect(res.status).toBe(404);
    });

    it("returns list of suspensions for the session", async () => {
      await createSuspension(store, { id: "susp-a" });
      await createSuspension(store, { id: "susp-b" });
      const app = createTestApp(makeDefaultDeps(store));

      const res = await app.request("/api/sessions/sess-1/suspensions");

      expect(res.status).toBe(200);
      const body = (await res.json()) as Record<string, unknown>;
      const suspensions = body.items as unknown[];
      expect(suspensions).toHaveLength(2);
    });

    it("omits resolved and claimed suspensions", async () => {
      await createSuspension(store, { id: "susp-open" });
      await createSuspension(store, {
        id: "susp-done",
        resolvedAt: "2026-09-04T01:02:03.000Z",
      });
      const app = createTestApp(makeDefaultDeps(store));

      const res = await app.request("/api/sessions/sess-1/suspensions");

      const body = (await res.json()) as { items: { id: string }[] };
      expect(body.items.map((item) => item.id)).toEqual(["susp-open"]);
    });

    it("returns only the public suspension summary", async () => {
      const createdAt = "2026-09-04T01:02:03.000Z";
      await createSuspension(store, { createdAt });
      const app = createTestApp(makeDefaultDeps(store));

      const res = await app.request("/api/sessions/sess-1/suspensions");

      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        items: Array<Record<string, unknown>>;
      };
      expect(body.items).toEqual([
        {
          id: "susp-1",
          sessionId: "sess-1",
          turnId: "turn-1",
          runtimeId: "test-plugin",
          pluginId: "test-plugin",
          reason: "Need player input",
          resumeSchema: {
            type: "object",
            properties: { name: { type: "string" } },
            required: ["name"],
          },
          createdAt,
        },
      ]);
      expect(body.items[0]).not.toHaveProperty("pendingContinuation");
      expect(body.items[0]).not.toHaveProperty("resolvedAt");
    });

    it("does not include suspensions from other sessions", async () => {
      await createSession(store, "sess-other");
      await createSuspension(store, { id: "susp-mine" });
      await createSuspension(store, {
        id: "susp-theirs",
        sessionId: "sess-other",
      });
      const app = createTestApp(makeDefaultDeps(store));

      const res = await app.request("/api/sessions/sess-1/suspensions");

      const body = (await res.json()) as Record<string, unknown>;
      const suspensions = body.items as Array<Record<string, unknown>>;
      expect(suspensions).toHaveLength(1);
      expect(suspensions[0]!.id).toBe("susp-mine");
    });
  });

  describe("TTL sweep wiring", () => {
    const OLD = "2020-01-01T00:00:00.000Z";

    // The sweep is fired-and-forgotten inside the handler; let it settle.
    const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

    beforeEach(() => {
      __resetSweepClockForTests();
    });

    it("GET /:id/suspensions opportunistically sweeps an expired unresolved suspension", async () => {
      await createSuspension(store, { id: "susp-old", createdAt: OLD });
      await createSuspension(store, { id: "susp-fresh" });
      const app = createTestApp(makeDefaultDeps(store));

      const res = await app.request("/api/sessions/sess-1/suspensions");
      expect(res.status).toBe(200);
      await flush();

      expect(await store.getSuspension("susp-old")).toBeNull();
      expect(await store.getSuspension("susp-fresh")).not.toBeNull();
      // Expiry ends the turn the old suspension held back, like an abandon.
      expect((await store.getSession("sess-1"))?.completedPlayerTurns).toBe(2);
    });

    it("GET /:id/suspensions never sweeps a claimed (in-flight) suspension even if old", async () => {
      await createSuspension(store, {
        id: "susp-claimed",
        createdAt: OLD,
        resolvedAt: `claimed:${new Date().toISOString()}`,
      });
      const app = createTestApp(makeDefaultDeps(store));

      await app.request("/api/sessions/sess-1/suspensions");
      await flush();

      // Claimed records (a resume in flight) must survive the sweep. A claim
      // older than an hour is released and then expires like any other.
      expect(await store.getSuspension("susp-claimed")).not.toBeNull();
    });

    it("POST resume opportunistically sweeps an expired unresolved suspension", async () => {
      await createSuspension(store, { id: "susp-old-post", createdAt: OLD });
      await createSuspension(store, { id: "susp-fresh-post" });
      const app = createTestApp(makeDefaultDeps(store));

      // The sweep fires at the very top of the POST handler. The requested
      // suspension does not exist, but the opportunistic sweep still runs.
      const res = await app.request(
        "/api/sessions/sess-1/suspensions/irrelevant/resume",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ data: null }),
        },
      );
      expect(res.status).toBe(404);
      await flush();

      expect(await store.getSuspension("susp-old-post")).toBeNull();
      expect(await store.getSuspension("susp-fresh-post")).not.toBeNull();
    });
  });
});
