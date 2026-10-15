import { describe, expect, it } from "vitest";
import { Hono } from "hono";
import { createEventBus } from "@covel/events";
import {
  createPluginRegistry,
  type LoadedRuntime,
  type PluginRegistryEntry,
} from "@covel/plugin-loader";
import { createHookPipeline } from "@covel/runtime";
import type { RuntimeManifest } from "@covel/shared";
import { createMemoryStore } from "@covel/store/memory";
import { actionRoutes } from "../../src/routes/api/actions.js";
import { createInProcessSessionLock } from "../../src/lib/session-lock.js";
import { parseJsonFrames } from "./sse-test-utils.js";

const SESSION_ID = "session-suspension-accounting";
const PLUGIN_ID = "suspension-fixture";

interface ActionEnvelope {
  readonly type: string;
  readonly sessionId: string;
  readonly turnId: string;
  readonly payload: Record<string, unknown>;
}

function manifest(name: string): RuntimeManifest {
  return {
    name,
    pluginId: PLUGIN_ID,
    description: name,
    stage: "narrative",
    runtimeType: "function",
    trigger: { type: "auto" },
    outputKind: "system",
  };
}

interface ScenarioOptions {
  readonly failCommit: boolean;
  /** Add a detached post-turn runtime whose job a suspended turn holds back. */
  readonly detached?: boolean;
}

const notesManifest: RuntimeManifest = {
  ...manifest("suspension-fixture/notes"),
  stage: "post-turn",
  turnCompletion: { mode: "detached" },
  effects: { writes: ["plugin-data:self:notes"] },
};

async function buildScenario(options: ScenarioOptions) {
  const store = createMemoryStore();
  await store.createSession({
    metadata: {
      approvalScopeNonce: globalThis.crypto.randomUUID(),
      sessionIncarnationNonce: globalThis.crypto.randomUUID(),
    },
    id: SESSION_ID,
    status: "active",
    locale: "zh-CN",
    activePlugins: [PLUGIN_ID],
    phase: "playing",
    completedPlayerTurns: 3,
    setupRuntimes: {},

    createdAt: "2026-08-25T00:00:00.000Z",
    updatedAt: "2026-08-25T00:00:00.000Z",
  });

  const suspendManifest = manifest("suspension-fixture/suspend");
  const writerManifest = manifest("suspension-fixture/writer");
  const loaded = new Map<string, LoadedRuntime>([
    [
      suspendManifest.name,
      {
        manifest: suspendManifest,
        promptTemplate: "",
        handler: async () => ({
          outcome: "suspended",
          reason: "need a choice",
          resumeSchema: { type: "string" },
        }),
      },
    ],
    [
      writerManifest.name,
      {
        manifest: writerManifest,
        promptTemplate: "",
        handler: async () => ({
          outcome: "success",
          effects: {
            statePatches: [{ table: "world", field: "weather", value: "rain" }],
          },
        }),
      },
    ],
    [
      notesManifest.name,
      {
        manifest: notesManifest,
        promptTemplate: "",
        handler: async () => ({ outcome: "success", value: { ok: true } }),
      },
    ],
  ]);
  const manifests = [
    suspendManifest,
    ...(options.failCommit ? [writerManifest] : []),
    ...(options.detached ? [notesManifest] : []),
  ];
  const registry = createPluginRegistry();
  registry.register({
    id: PLUGIN_ID,
    source: "builtin",
    summary: {
      id: PLUGIN_ID,
      name: PLUGIN_ID,
      description: "",
      version: "0.0.0",
      pluginType: "plugin",
      source: "builtin",
      runtimeCount: manifests.length,
    },
    manifests: manifests.map((runtimeManifest) => ({
      runtime: { type: runtimeManifest.runtimeType ?? ("agent" as const) },
      manifest: runtimeManifest,
      promptTemplate: "",
      rawFrontmatter: {},
    })),
    loadedRuntimes: loaded,
    status: "registered",
  } as PluginRegistryEntry);

  const hookPipeline = createHookPipeline();
  if (options.failCommit) {
    hookPipeline.register({
      id: "reject-writer",
      event: "PreStateCommit",
      handler: async () => ({ action: "abort", reason: "forced rollback" }),
    });
  }

  const app = new Hono();
  const eventBus = createEventBus(store);
  app.use("*", async (c, next) => {
    c.set("store", store);
    c.set("pluginRegistry", registry);
    c.set("llmAdapter", {
      generate: async () => {
        throw new Error("function runtimes must not call the LLM");
      },
    });
    c.set("loadRuntimeFn", async (runtimeManifest: RuntimeManifest) =>
      loaded.get(runtimeManifest.name),
    );
    c.set("resolveModel", () => undefined);
    c.set("eventBus", eventBus);
    c.set("sessionLock", createInProcessSessionLock());
    c.set("hookPipeline", hookPipeline);
    await next();
  });
  app.route("/api/actions", actionRoutes);
  const send = async (requestId: string) => {
    const response = await app.request("/api/actions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        requestId,
        type: "send_message",
        sessionId: SESSION_ID,
        payload: { content: "continue" },
      }),
    });
    expect(response.status).toBe(200);
    return parseJsonFrames<ActionEnvelope>(await response.text());
  };
  return { store, send };
}

async function runScenario(options: ScenarioOptions) {
  const { store, send } = await buildScenario(options);
  const envelopes = await send(
    `request-${options.failCommit ? "rollback" : "suspend"}`,
  );
  return { store, envelopes };
}

describe("POST /api/actions suspension accounting", () => {
  it("does not complete the logical player turn at the suspension boundary", async () => {
    const { store, envelopes } = await runScenario({ failCommit: false });

    expect((await store.getSession(SESSION_ID))?.completedPlayerTurns).toBe(3);
    const suspensions = await store.listSuspensions(SESSION_ID);
    expect(suspensions).toHaveLength(1);
    const suspension = suspensions[0]!;
    const suspended = envelopes.filter(
      (envelope) => envelope.type === "turn.suspended",
    );

    expect(suspended).toHaveLength(1);
    expect(suspended[0]).toMatchObject({
      sessionId: suspension.sessionId,
      turnId: suspension.turnId,
      payload: {
        suspensionId: suspension.id,
        sessionId: suspension.sessionId,
        turnId: suspension.turnId,
        runtimeId: suspension.runtimeId,
        pluginId: suspension.pluginId,
        reason: suspension.reason,
        resumeSchema: suspension.resumeSchema,
      },
    });
    expect(envelopes.map((envelope) => envelope.type)).not.toContain(
      "turn.completed",
    );
  });

  it("removes a continuation when a sibling proposal rolls back", async () => {
    const { store, envelopes } = await runScenario({ failCommit: true });

    expect((await store.getSession(SESSION_ID))?.completedPlayerTurns).toBe(3);
    expect(await store.listSuspensions(SESSION_ID)).toHaveLength(0);
    expect(envelopes.map((envelope) => envelope.type)).not.toContain(
      "turn.suspended",
    );
    expect(envelopes.map((envelope) => envelope.type)).not.toContain(
      "turn.completed",
    );
  });

  it("voids the runtime's older suspension when it suspends again and queues the jobs that turn held back (F-016)", async () => {
    const { store, send } = await buildScenario({
      failCommit: false,
      detached: true,
    });
    const queuedNotes = async () =>
      (await store.listJobStatus(SESSION_ID)).filter(
        (status) =>
          status.runtimeId === notesManifest.name && status.state === "queued",
      );

    await send("request-first");
    const [first] = await store.listSuspensions(SESSION_ID);
    expect(first).toBeDefined();
    // The suspended turn holds its detached job back.
    expect(await queuedNotes()).toHaveLength(0);

    const envelopes = await send("request-second");

    const pending = await store.listSuspensions(SESSION_ID);
    expect(pending).toHaveLength(1);
    expect(pending[0]!.id).not.toBe(first!.id);
    expect(await store.getSuspension(first!.id)).toBeNull();
    // The voided suspension ended the first turn: it counts and its job runs.
    expect((await store.getSession(SESSION_ID))?.completedPlayerTurns).toBe(4);
    expect(await queuedNotes()).toHaveLength(1);
    expect(
      envelopes
        .filter((envelope) => envelope.type === "turn.suspended")
        .map((envelope) => envelope.payload.suspensionId),
    ).toEqual([pending[0]!.id]);
  });
});
