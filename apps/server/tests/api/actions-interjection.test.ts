/**
 * POST /api/actions × steer — a mid-turn interjection follows its turn's
 * transaction (audit F-023).
 *
 * - A committed turn saves the interjection to the prompt history
 *   (`turn_messages`, after the player's message) and the chat log, so the
 *   next turn's model reads it; it does not count as a player turn.
 * - A stopped turn keeps it in neither table.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Hono } from "hono";
import type { DataStore } from "@covel/store";
import { createMemoryStore } from "@covel/store/memory";
import { createEventBus, type EventBus } from "@covel/events";
import {
  createPluginRegistry,
  type LoadedRuntime,
  type PluginRegistryEntry,
} from "@covel/plugin-loader";
import type { LLMAdapter, LLMResponse } from "@covel/runtime";
import { actionRoutes } from "../../src/routes/api/actions.js";
import { createInProcessSessionLock } from "../../src/lib/session-lock.js";
import { turnControlRoutes } from "../../src/routes/api/turn-control-routes.js";
import { makeFakeLoadedRuntime } from "./__helpers/fake-llm.js";
import { parseJsonFrames } from "./sse-test-utils.js";

const SESSION_ID = "sess-interjection";
const RUNTIME_ID = "fake-narrator";
const INTERJECTION = "Don't let him leave.";

interface Envelope {
  type: string;
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
      kind: "plugin",
      runtimeCount: 1,
    },
    manifests: [
      {
        runtime: {},
        manifest: loaded.manifest,
        promptTemplate: loaded.promptTemplate,
        rawFrontmatter: {},
      },
    ],
    loadedRuntimes: new Map([[loaded.manifest.name, loaded]]),
    status: "registered",
  } as PluginRegistryEntry;
}

describe("POST /api/actions — a mid-turn interjection follows the turn", () => {
  let store: DataStore;
  let eventBus: EventBus;
  let app: Hono;
  /** Every model request's user-visible messages, in call order. */
  let prompts: Array<ReadonlyArray<{ role: string; content: unknown }>>;
  /** Runs during the model call of the turn's first step. */
  let duringFirstCall: (() => Promise<void>) | undefined;

  beforeEach(async () => {
    store = createMemoryStore();
    const registry = createPluginRegistry();
    const loaded = makeFakeLoadedRuntime({ name: RUNTIME_ID });
    registry.register(makeEntry(loaded));
    prompts = [];
    duringFirstCall = undefined;
    const llm: LLMAdapter = {
      async generate(params): Promise<LLMResponse> {
        prompts.push(
          params.messages.map((m) => ({ role: m.role, content: m.content })),
        );
        const hook = duringFirstCall;
        duringFirstCall = undefined;
        await hook?.();
        return {
          content: `Narration ${prompts.length}.`,
          toolCalls: [],
          finishReason: "stop",
          usage: { inputTokens: 1, outputTokens: 1 },
        };
      },
    };
    eventBus = createEventBus(store);
    const sessionLock = createInProcessSessionLock();
    await store.createSession({
      id: SESSION_ID,
      locale: "en",
      phase: "playing",
      status: "active",
      setupRuntimes: {},
      seats: [
        { id: "main", controller: "human", role: "player", characters: "auto" },
      ],
      metadata: {
        approvalScopeNonce: crypto.randomUUID(),
        sessionIncarnationNonce: crypto.randomUUID(),
      },
      activePlugins: [RUNTIME_ID],
      completedPlayerTurns: 1,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
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
    app.route("/api/sessions", turnControlRoutes);
  });

  afterEach(async () => {
    await eventBus.close();
    await store.close();
  });

  const send = async (content: string) => {
    const response = await app.request("/api/actions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        requestId: crypto.randomUUID(),
        sessionId: SESSION_ID,
        type: "submit_actions",
        payload: { actions: [{ kind: "say", text: content }] },
      }),
    });
    const events = parseJsonFrames<Envelope>(await response.text());
    return events.find((event) => event.type === "execution.completed")
      ?.payload;
  };
  const control = (path: "steer" | "abort", body?: unknown) =>
    app.request(`/api/sessions/${SESSION_ID}/${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
  const interjectionsIn = (rows: ReadonlyArray<{ content: string }>) =>
    rows.filter((row) => row.content === INTERJECTION);

  it("a committed turn saves the interjection to the history and the chat log", async () => {
    duringFirstCall = async () => {
      const steered = await control("steer", { message: INTERJECTION });
      expect(steered.status).toBe(200);
    };

    expect(await send("Follow the stranger.")).toMatchObject({
      committed: true,
    });
    // The interjection reached this turn: one more step read it.
    expect(prompts).toHaveLength(2);
    expect(prompts[1]?.at(-1)).toEqual({ role: "user", content: INTERJECTION });

    const history = await store.listUncompactedTurnMessages(SESSION_ID);
    expect(
      history.map((row) => [row.sourceType, row.role, row.content]),
    ).toEqual([
      ["player", "user", "earlier"],
      ["player", "user", "Follow the stranger."],
      ["player-interjection", "user", INTERJECTION],
      ["runtime", "assistant", "Narration 1.\n\nNarration 2."],
    ]);
    // One player turn, not two.
    expect(
      (await store.getTurnMessageStats(SESSION_ID)).playerMessageCount,
    ).toBe(2);
    expect((await store.getSession(SESSION_ID))?.completedPlayerTurns).toBe(2);
    const [shown] = interjectionsIn(await store.listMessages(SESSION_ID));
    expect(shown).toMatchObject({
      role: "user",
      metadata: { steered: true, turnId: history[1]?.turnId },
    });

    // The next turn's model reads the player's words, not only the reply.
    await send("Ask him his name.");
    expect(
      prompts[2]?.some(
        (message) =>
          message.role === "user" && message.content === INTERJECTION,
      ),
    ).toBe(true);
  });

  it("saves setup interjections once and reads them from history in the opening", async () => {
    await store.updateSession(SESSION_ID, { phase: "setup" });
    const addTraceEvent = store.addTraceEvent.bind(store);
    let injected = false;
    store.addTraceEvent = async (event) => {
      if (event.type === "turn.started" && !injected) {
        injected = true;
        expect((await control("steer", { message: INTERJECTION })).status).toBe(
          200,
        );
      }
      await addTraceEvent(event);
    };
    const response = await app.request("/api/actions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        requestId: crypto.randomUUID(),
        sessionId: SESSION_ID,
        type: "start_session",
        payload: {},
      }),
    });
    const events = parseJsonFrames<Envelope>(await response.text());
    expect(events.at(-1)).toMatchObject({
      type: "execution.completed",
      payload: { committed: true },
    });
    expect(injected).toBe(true);
    expect(await store.listTurnResults(SESSION_ID)).toHaveLength(2);
    expect(
      interjectionsIn(await store.listTurnMessages(SESSION_ID)),
    ).toHaveLength(1);
    expect(interjectionsIn(await store.listMessages(SESSION_ID))).toHaveLength(
      1,
    );
    expect(prompts).toHaveLength(1);
    expect(
      prompts[0]?.filter(
        (message) =>
          message.role === "user" && message.content === INTERJECTION,
      ),
    ).toHaveLength(1);
  });

  it("a stopped turn keeps the interjection in neither table", async () => {
    duringFirstCall = async () => {
      expect((await control("steer", { message: INTERJECTION })).status).toBe(
        200,
      );
      expect((await control("abort")).status).toBe(200);
    };

    expect(await send("Follow the stranger.")).toMatchObject({
      committed: false,
    });

    expect(interjectionsIn(await store.listMessages(SESSION_ID))).toEqual([]);
    expect(interjectionsIn(await store.listTurnMessages(SESSION_ID))).toEqual(
      [],
    );
  });
});
