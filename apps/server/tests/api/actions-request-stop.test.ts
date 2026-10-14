/**
 * POST /api/actions — how an action ends (audit F-030, F-184, F-104, F-100).
 *
 * - A stop applies to the player's request: it ends the wait for the session
 *   lock, and a stop between the setup turn and the opening continuation
 *   keeps the opening from starting (recorded so it can be run later).
 * - After a turn is saved, a failed `turn.completed` debug record is only
 *   logged: the stream still ends with the completion frame and the opening
 *   still runs.
 * - A resent input whose turn is saved is refused before any model call.
 * - A stale retry is refused with a code and its message in production.
 */

import { AsyncResource } from "node:async_hooks";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import type { DataStore } from "@covel/store";
import { createMemoryStore } from "@covel/store/memory";
import { createEventBus, type EventBus } from "@covel/events";
import {
  createPluginRegistry,
  type LoadedRuntime,
  type PluginRegistryEntry,
} from "@covel/plugin-loader";
import { PLAYER_ABORT_REASON } from "@covel/shared";
import { actionRoutes } from "../../src/routes/api/actions.js";
import {
  createInProcessSessionLock,
  type SessionLock,
} from "../../src/lib/session-lock.js";
import {
  abortActiveTurn,
  hasActiveTurn,
} from "../../src/routes/api/turn-control.js";
import { getSessionExecutionStatus } from "../../src/routes/api/actions/execution-recovery.js";
import { makeFakeLLM, makeFakeLoadedRuntime } from "./__helpers/fake-llm.js";
import { parseJsonFrames } from "./sse-test-utils.js";

const SESSION_ID = "sess-request-stop";
const RUNTIME_ID = "fake-narrator";

interface Envelope {
  type: string;
  turnId?: string;
  payload?: Record<string, unknown>;
}

function makeEntry(loaded: LoadedRuntime): PluginRegistryEntry {
  return {
    id: loaded.manifest.pluginId,
    source: "builtin",
    summary: {
      id: loaded.manifest.pluginId,
      name: loaded.manifest.pluginId,
      description: "",
      pluginType: "plugin",
      runtimeCount: 1,
    },
    manifests: [
      {
        runtime: { type: "agent" as const },
        manifest: loaded.manifest,
        promptTemplate: loaded.promptTemplate,
        rawFrontmatter: {},
      },
    ],
    loadedRuntimes: new Map([[loaded.manifest.name, loaded]]),
    status: "registered",
  } as PluginRegistryEntry;
}

describe("POST /api/actions — how an action ends", () => {
  let store: DataStore;
  let eventBus: EventBus;
  let sessionLock: SessionLock;
  let llmCalls: readonly unknown[];
  let app: Hono;

  beforeEach(async () => {
    store = createMemoryStore();
    const registry = createPluginRegistry();
    const loaded = makeFakeLoadedRuntime({ name: RUNTIME_ID });
    registry.register(makeEntry(loaded));
    const { llm, calls } = makeFakeLLM("The story begins.");
    llmCalls = calls;
    eventBus = createEventBus(store);
    sessionLock = createInProcessSessionLock();
    await store.createSession({
      id: SESSION_ID,
      locale: "en",
      phase: "playing",
      status: "active",
      setupRuntimes: {},
      metadata: {
        approvalScopeNonce: crypto.randomUUID(),
        sessionIncarnationNonce: crypto.randomUUID(),
      },
      activePlugins: [RUNTIME_ID],
      completedPlayerTurns: 1,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    // One earlier player message, so the narrator runs in the main loop.
    await store.appendTurnMessage({
      id: "prior-player",
      sessionId: SESSION_ID,
      turnId: "prior-turn",
      sourceType: "player",
      role: "user",
      content: "earlier",
      order: 0,
      createdAt: "2024-01-01T00:00:00Z",
    });
    app = new Hono();
    app.use("*", async (c, next) => {
      c.set("store", store);
      c.set("pluginRegistry", registry);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      c.set("llmAdapter", llm as any);
      c.set("loadRuntimeFn", async () => loaded);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      c.set("toolExecutor", undefined as any);
      c.set("resolveModel", () => undefined);
      c.set("eventBus", eventBus);
      c.set("sessionLock", sessionLock);
      await next();
    });
    app.route("/api/actions", actionRoutes);
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await eventBus.close();
    await store.close();
  });

  const post = (body: Record<string, unknown>) =>
    app.request("/api/actions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        requestId: crypto.randomUUID(),
        sessionId: SESSION_ID,
        ...body,
      }),
    });
  const run = async (body: Record<string, unknown>) =>
    parseJsonFrames<Envelope>(await (await post(body)).text());
  const last = (events: Envelope[]) => events.at(-1);

  it("a stop ends the wait for the session lock, and nothing is stored", async () => {
    const locked = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const blocker = sessionLock.withLock(SESSION_ID, async () => {
      locked.resolve();
      await release.promise;
    });
    try {
      await locked.promise;
      const response = await post({
        type: "send_message",
        payload: { content: "never runs" },
      });
      const body = response.text();
      // The request is admitted and waits for the lock: a stop reaches it.
      let stopped = abortActiveTurn(SESSION_ID);
      for (let i = 0; !stopped && i < 100; i += 1) {
        await new Promise((resolve) => setImmediate(resolve));
        stopped = abortActiveTurn(SESSION_ID);
      }
      expect(stopped).not.toBeNull();
      // The stream ends while the lock is still held by someone else.
      const events = parseJsonFrames<Envelope>(await body);
      expect(events.map((event) => event.type)).toEqual([
        "execution.completed",
      ]);
      expect(last(events)?.payload).toMatchObject({
        committed: false,
        abortReason: PLAYER_ABORT_REASON,
      });
    } finally {
      release.resolve();
      await blocker;
    }
    expect(llmCalls).toHaveLength(0);
    expect(await store.listTurnResults(SESSION_ID)).toEqual([]);
    expect(await store.listMessages(SESSION_ID)).toEqual([]);
    expect(hasActiveTurn(SESSION_ID)).toBe(false);
    expect(abortActiveTurn(SESSION_ID)).toBeNull();
  });

  it("a stop after the setup turn keeps the opening from starting and offers it later", async () => {
    await store.updateSession(SESSION_ID, { phase: "setup" });
    // While the setup turn holds the lock, queue a holder that runs right
    // after it releases — before the opening continuation takes the lock —
    // and stops the request there.
    let stoppedTurn: { turnId: string } | null = null;
    let queued: Promise<void> | undefined;
    // Bound to this context: from inside the turn the lock would be re-entered.
    const queueHolder = AsyncResource.bind(() =>
      sessionLock.withLock(SESSION_ID, async () => {
        stoppedTurn = abortActiveTurn(SESSION_ID);
      }),
    );
    const addTraceEvent = store.addTraceEvent.bind(store);
    store.addTraceEvent = async (event) => {
      if (event.type === "turn.started" && !queued) queued = queueHolder();
      await addTraceEvent(event);
    };

    const events = await run({ type: "start_session", payload: {} });
    await queued;

    expect(stoppedTurn).not.toBeNull();
    const completed = last(events);
    expect(completed?.type).toBe("execution.completed");
    expect(completed?.payload).toMatchObject({
      committed: false,
      abortReason: PLAYER_ABORT_REASON,
    });
    // The setup turn is saved; the opening never ran.
    expect(llmCalls).toHaveLength(0);
    const turns = await store.listTurnResults(SESSION_ID);
    expect(turns).toHaveLength(1);
    expect(turns[0]?.commitStatus).toBe("committed");
    expect((await store.getSession(SESSION_ID))?.phase).toBe("playing");
    // The stopped opening can be run later as the continuation it was.
    const status = await getSessionExecutionStatus(store, SESSION_ID);
    expect(status).toMatchObject({
      state: "failed",
      turnId: completed?.turnId,
      origin: "continuation",
      abortReason: PLAYER_ABORT_REASON,
      retry: { type: "retry_turn", payload: {} },
    });
    // Once the request ended there is nothing left to stop.
    expect(abortActiveTurn(SESSION_ID)).toBeNull();

    // Continuing runs the opening as the continuation it was.
    const turnsBefore = (await store.getSession(SESSION_ID))
      ?.completedPlayerTurns;
    const resumed = await run({
      type: "retry_turn",
      payload: { recoverFromTurnId: completed?.turnId },
    });
    expect(last(resumed)?.payload).toMatchObject({ committed: true });
    expect(llmCalls).toHaveLength(1);
    expect((await store.getSession(SESSION_ID))?.completedPlayerTurns).toBe(
      turnsBefore,
    );
  });

  it("a failed turn.completed record after the commit is only logged", async () => {
    await store.updateSession(SESSION_ID, { phase: "setup" });
    const addTraceEvent = store.addTraceEvent.bind(store);
    store.addTraceEvent = async (event) => {
      if (event.type === "turn.completed")
        throw new Error("trace store unavailable");
      await addTraceEvent(event);
    };
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const events = await run({ type: "start_session", payload: {} });

      expect(events.some((event) => event.type === "error.occurred")).toBe(
        false,
      );
      expect(last(events)).toMatchObject({
        type: "execution.completed",
        payload: { committed: true },
      });
      // The opening still ran after the setup turn.
      expect(llmCalls).toHaveLength(1);
      const turns = await store.listTurnResults(SESSION_ID);
      expect(turns.map((turn) => turn.commitStatus)).toEqual([
        "committed",
        "committed",
      ]);
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining("recording turn.completed failed"),
        expect.any(Error),
      );
    } finally {
      warn.mockRestore();
    }
  });

  it("refuses a resent input whose turn is saved before any model call", async () => {
    const input = { content: "go north", inputMessageId: "input-1" };
    const first = await run({ type: "send_message", payload: input });
    expect(last(first)?.payload).toMatchObject({ committed: true });
    expect(llmCalls).toHaveLength(1);

    const resent = await run({ type: "send_message", payload: input });

    expect(resent.map((event) => event.type)).toEqual(["error.occurred"]);
    expect(last(resent)?.payload).toMatchObject({
      code: "input_already_committed",
    });
    expect(llmCalls).toHaveLength(1);
    expect(await store.listTurnResults(SESSION_ID)).toHaveLength(1);
  });

  it("refuses a stale retry with its code and message in production", async () => {
    vi.stubEnv("NODE_ENV", "production");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const events = await run({
        type: "retry_runtime",
        payload: { runtimeId: RUNTIME_ID, retryFromTurnId: "no-such-turn" },
      });

      expect(events.map((event) => event.type)).toEqual(["error.occurred"]);
      expect(last(events)?.payload).toEqual({
        message: "The retry source turn was not found in this session.",
        code: "retry_source_not_found",
      });
      // An expected refusal is not logged as a failed turn.
      expect(error).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
      error.mockRestore();
    }
    expect(llmCalls).toHaveLength(0);
  });
});
