/**
 * POST /api/actions `submit_actions` and GET /api/sessions/:id/action-kinds.
 *
 * - Every action is checked against the session in a fixed order; the first
 *   failure refuses the whole submission with its code and status, and
 *   nothing is stored.
 * - A single player's message keeps its text as the model reads it; another
 *   character, a host and a plugin kind are named in the rendering.
 * - The chat row keeps the raw text and the resolved actions; the journal row
 *   keeps the rendering.
 * - Forms and choices are answered by actions; a spectator cannot answer.
 * - A failed turn is retried with its resolved actions.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Hono } from "hono";
import type { DataStore } from "@covel/store";
import { createMemoryStore } from "@covel/store/memory";
import { createEventBus, type EventBus } from "@covel/events";
import {
  createPluginRegistry,
  parsePluginMd,
  type LoadedRuntime,
  type PluginRegistryEntry,
} from "@covel/plugin-loader";
import type { LLMAdapter, LLMResponse } from "@covel/runtime";
import type {
  ActionKindDescriptor,
  Seat,
  SessionActionKindsResponse,
  TurnAction,
} from "@covel/shared";
import { actionRoutes } from "../../src/routes/api/actions.js";
import { messageRoutes } from "../../src/routes/api/messages.js";
import { sessionRoutes } from "../../src/routes/api/session.js";
import { createInProcessSessionLock } from "../../src/lib/session-lock.js";
import { makeFakeLoadedRuntime } from "./__helpers/fake-llm.js";
import { parseJsonFrames } from "./sse-test-utils.js";

const SESSION_ID = "sess-submit-actions";
const NARRATOR = "fake-narrator";
const WHISPER_PACK = "whisper-pack";
const AT = "2026-01-01T00:00:00.000Z";

interface Envelope {
  type: string;
  turnId: string;
  payload: Record<string, unknown>;
}

const MAIN: Seat = {
  id: "main",
  controller: "human",
  role: "player",
  characters: "auto",
};

const whisperKind: ActionKindDescriptor = {
  kind: `${WHISPER_PACK}/whisper`,
  source: "plugin",
  pluginId: WHISPER_PACK,
  roles: ["player"],
  text: "required",
  actor: true,
  display: { label: { en: "whispers", zh: "耳语" } },
  fieldsSchema: {
    type: "object",
    properties: { target: { type: "string" } },
    required: ["target"],
    additionalProperties: false,
  },
};

/** A plugin kind taken without text and without fields. */
const passKind: ActionKindDescriptor = {
  kind: `${WHISPER_PACK}/pass`,
  source: "plugin",
  pluginId: WHISPER_PACK,
  roles: ["player"],
  text: "none",
  actor: true,
  display: { label: { en: "passes", zh: "让过" } },
};

function narratorEntry(loaded: LoadedRuntime): PluginRegistryEntry {
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

/** A package with no runtime: it only declares an action kind. */
function whisperEntry(): PluginRegistryEntry {
  return {
    id: WHISPER_PACK,
    source: "builtin",
    summary: {
      id: WHISPER_PACK,
      name: WHISPER_PACK,
      description: "",
      kind: "plugin",
      runtimeCount: 0,
    },
    packageManifest: {
      ...parsePluginMd(
        `---\n${JSON.stringify({ id: WHISPER_PACK, kind: "plugin", description: "Whispers" })}\n---\n`,
        `${WHISPER_PACK}/PLUGIN.md`,
      ),
      actionKinds: [whisperKind, passKind],
    },
    manifests: [],
    loadedRuntimes: new Map(),
    status: "registered",
  } as PluginRegistryEntry;
}

describe("submit_actions", () => {
  let store: DataStore;
  let eventBus: EventBus;
  let app: Hono;
  /** The last user message of each model request. */
  let userMessages: string[];

  beforeEach(async () => {
    store = createMemoryStore();
    const registry = createPluginRegistry();
    const loaded = makeFakeLoadedRuntime({ name: NARRATOR });
    registry.register(narratorEntry(loaded));
    registry.register(whisperEntry());
    userMessages = [];
    const llm: LLMAdapter = {
      async generate(params): Promise<LLMResponse> {
        const last = [...params.messages]
          .reverse()
          .find((message) => message.role === "user");
        userMessages.push(
          typeof last?.content === "string" ? last.content : "",
        );
        return {
          content: "The story moves on.",
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
      locale: "en-US",
      phase: "playing",
      status: "active",
      setupRuntimes: {},
      seats: [MAIN],
      metadata: {
        approvalScopeNonce: crypto.randomUUID(),
        sessionIncarnationNonce: crypto.randomUUID(),
      },
      activePlugins: [NARRATOR, WHISPER_PACK],
      completedPlayerTurns: 1,
      createdAt: AT,
      updatedAt: AT,
    });
    await addCharacter("hero", "Hero", "player");
    await addCharacter("guide", "Guide", "npc");
    await store.appendTurnMessage({
      id: "prior-player",
      sessionId: SESSION_ID,
      turnId: "prior-turn",
      sourceType: "player",
      role: "user",
      content: "earlier",
      order: 0,
      createdAt: AT,
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
    app.route("/api/sessions", messageRoutes);
    app.route("/api/sessions", sessionRoutes);
  });

  afterEach(async () => {
    await eventBus.close();
    await store.close();
  });

  async function addCharacter(id: string, name: string, type: string) {
    await store.upsertCharacter({
      id,
      sessionId: SESSION_ID,
      name,
      type,
      version: 1,
      createdAt: AT,
      updatedAt: AT,
    });
  }

  async function setSeats(seats: Seat[]) {
    await store.updateSession(SESSION_ID, { seats, updatedAt: AT });
  }

  function post(payload: Record<string, unknown>, type = "submit_actions") {
    return app.request("/api/actions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        requestId: crypto.randomUUID(),
        sessionId: SESSION_ID,
        type,
        payload,
      }),
    });
  }

  async function submit(
    payload: Record<string, unknown>,
    type = "submit_actions",
  ) {
    const response = await post(payload, type);
    expect(response.status, await response.clone().text()).toBe(200);
    return parseJsonFrames<Envelope>(await response.text());
  }

  function completed(events: readonly Envelope[]) {
    return events.find((event) => event.type === "execution.completed")
      ?.payload;
  }

  async function userRows() {
    return (await store.listMessages(SESSION_ID)).filter(
      (message) => message.role === "user",
    );
  }

  async function journalRows() {
    return (await store.listTurnMessages(SESSION_ID)).filter(
      (message) =>
        message.sourceType === "player" && message.turnId !== "prior-turn",
    );
  }

  async function startedPayload(turnId: string) {
    const [started] = await store.queryTraceEvents(SESSION_ID, {
      turnId,
      types: ["turn.started"],
    });
    return started?.payload as Record<string, unknown> | undefined;
  }

  it("keeps a single player's message as the model reads it and stores the resolved actions", async () => {
    const events = await submit({
      actions: [{ kind: "say", text: "Open the gate." }],
      inputMessageId: "input-1",
    });
    expect(completed(events)).toMatchObject({ committed: true });
    const resolved: TurnAction = {
      seatId: "main",
      kind: "say",
      actorId: "hero",
      text: "Open the gate.",
      source: "player",
    };
    const [row] = await userRows();
    expect(row).toMatchObject({
      id: "input-1",
      content: "Open the gate.",
      metadata: { actions: [resolved] },
    });
    expect((await journalRows()).map((message) => message.content)).toEqual([
      "Open the gate.",
    ]);
    expect(userMessages.at(-1)).toBe("Open the gate.");

    // The message API exposes the actions beside the raw text.
    const listed = (await (
      await app.request(`/api/sessions/${SESSION_ID}/messages`)
    ).json()) as { items: Array<{ role: string; actions?: unknown }> };
    expect(listed.items.find((item) => item.role === "user")?.actions).toEqual([
      resolved,
    ]);

    // The turn is retried with the same resolved actions.
    const turnId = events[0]!.turnId;
    expect(await startedPayload(turnId)).toMatchObject({
      recoveryAction: {
        type: "submit_actions",
        payload: {
          actions: [
            {
              seatId: "main",
              kind: "say",
              actorId: "hero",
              text: "Open the gate.",
            },
          ],
          inputMessageId: "input-1",
        },
      },
      playerInput: { actions: [resolved], messageId: "input-1" },
    });
  });

  it("names the second bound character and refuses one the seat does not bind", async () => {
    await addCharacter("scout", "Scout", "player");
    const events = await submit({
      actions: [{ kind: "say", actorId: "scout", text: "Wait for me." }],
    });
    expect(completed(events)).toMatchObject({ committed: true });
    expect((await journalRows()).map((message) => message.content)).toEqual([
      "[Scout · says] Wait for me.",
    ]);
    // The chat row keeps the raw text.
    expect((await userRows()).map((message) => message.content)).toEqual([
      "Wait for me.",
    ]);

    const refused = await post({
      actions: [{ kind: "say", actorId: "guide", text: "Hello." }],
    });
    expect(refused.status).toBe(409);
    expect(await refused.json()).toMatchObject({ code: "actor_not_bound" });
    expect(await userRows()).toHaveLength(1);
  });

  it.each([
    [
      "an unknown seat",
      { seatId: "nope", kind: "say", text: "Hi" },
      404,
      "seat_not_found",
    ],
    [
      "a seat without a human",
      { seatId: "empty", kind: "say", text: "Hi" },
      409,
      "seat_not_human",
    ],
    [
      "an unknown kind",
      { kind: "other-pack/dance", text: "Hi" },
      409,
      "unknown_action_kind",
    ],
    [
      "a kind the role may not use",
      { kind: "narrate", text: "Rain falls." },
      409,
      "action_kind_not_allowed",
    ],
    [
      "an actor on a kind without one",
      { kind: "command", actorId: "hero", text: "/roll" },
      409,
      "actor_not_bound",
    ],
    ["a say without text", { kind: "say", text: "  " }, 400, "invalid_action"],
    [
      "a command without a slash",
      { kind: "command", text: "roll" },
      400,
      "invalid_action",
    ],
    [
      "fields on a base kind",
      { kind: "say", text: "Hi", fields: { loud: true } },
      400,
      "invalid_action_fields",
    ],
    [
      "plugin fields that do not match the schema",
      { kind: whisperKind.kind, text: "Psst", fields: { to: "Guide" } },
      400,
      "invalid_action_fields",
    ],
  ])("refuses %s and stores nothing", async (_, action, status, code) => {
    await setSeats([
      MAIN,
      { id: "empty", controller: "empty", role: "player", characters: [] },
    ]);
    const response = await post({
      actions: [{ kind: "say", text: "A valid first action." }, action],
    });
    expect(response.status).toBe(status);
    expect(await response.json()).toMatchObject({ code });
    expect(await userRows()).toEqual([]);
    expect(await journalRows()).toEqual([]);
    expect(await store.listTurnResults(SESSION_ID)).toEqual([]);
    expect(
      await store.queryTraceEvents(SESSION_ID, { types: ["turn.started"] }),
    ).toEqual([]);
  });

  it("lets a host narrate but not speak", async () => {
    await setSeats([
      MAIN,
      { id: "host", controller: "human", role: "host", characters: [] },
    ]);
    const events = await submit({
      actions: [{ seatId: "host", kind: "narrate", text: "Rain falls." }],
    });
    expect(completed(events)).toMatchObject({ committed: true });
    expect((await journalRows()).map((message) => message.content)).toEqual([
      "[narration] Rain falls.",
    ]);
    const refused = await post({
      actions: [{ seatId: "host", kind: "say", text: "Hello." }],
    });
    expect(refused.status).toBe(409);
    expect(await refused.json()).toMatchObject({
      code: "action_kind_not_allowed",
    });
  });

  it("accepts a plugin kind whose fields match its schema", async () => {
    const events = await submit({
      actions: [
        { kind: whisperKind.kind, text: "Psst.", fields: { target: "Guide" } },
      ],
    });
    expect(completed(events)).toMatchObject({ committed: true });
    expect((await journalRows()).map((message) => message.content)).toEqual([
      '[Hero · whispers] Psst. {"target":"Guide"}',
    ]);
    expect((await userRows())[0]?.metadata).toMatchObject({
      actions: [
        {
          seatId: "main",
          kind: whisperKind.kind,
          actorId: "hero",
          fields: { target: "Guide" },
        },
      ],
    });
  });

  it("records a plugin kind taken without text, and refuses its resend", async () => {
    const input = {
      actions: [{ kind: passKind.kind }],
      inputMessageId: "pass-1",
    };
    const events = await submit(input);
    expect(completed(events)).toMatchObject({ committed: true });
    const resolved: TurnAction = {
      seatId: "main",
      kind: passKind.kind,
      actorId: "hero",
      source: "player",
    };
    // The model reads the label; the chat row shows it and keeps the action.
    expect(userMessages.at(-1)).toBe("[Hero · passes]");
    expect((await journalRows()).map((message) => message.content)).toEqual([
      "[Hero · passes]",
    ]);
    expect(await userRows()).toMatchObject([
      {
        id: "pass-1",
        content: "[Hero · passes]",
        metadata: { actions: [resolved] },
      },
    ]);
    const listed = (await (
      await app.request(`/api/sessions/${SESSION_ID}/messages`)
    ).json()) as { items: Array<{ role: string; actions?: unknown }> };
    expect(listed.items.find((item) => item.role === "user")?.actions).toEqual([
      resolved,
    ]);

    // The same input again is refused before another turn runs.
    const calls = userMessages.length;
    const resent = await submit(input);
    expect(resent.at(-1)).toMatchObject({
      type: "error.occurred",
      payload: { code: "input_already_committed" },
    });
    expect(userMessages).toHaveLength(calls);
    expect(await userRows()).toHaveLength(1);
  });

  it("refuses a submission whose texts and answers together pass the limit, storing nothing", async () => {
    await store.appendTurnMessage({
      id: "ask-long",
      sessionId: SESSION_ID,
      turnId: "ask-long-turn",
      sourceType: "runtime",
      sourcePluginId: NARRATOR,
      role: "assistant",
      content: "",
      order: 5,
      createdAt: AT,
      pendingInput: [
        {
          interactionId: "story",
          type: "form",
          title: "Story",
          submitLabel: "Go",
          fields: [{ type: "textarea", name: "story", label: "Story" }],
          narrativeTemplate: "{{story}}",
        },
      ],
    });
    const calls = userMessages.length;
    const events = await submit({
      actions: [
        { kind: "say", text: "a".repeat(60_000) },
        {
          kind: "act",
          interaction: {
            turnId: "ask-long-turn",
            interactionId: "story",
            type: "form",
          },
          fields: { story: "b".repeat(60_000) },
        },
      ],
    });
    expect(events.map((event) => event.type)).toEqual(["error.occurred"]);
    expect(events[0]).toMatchObject({ payload: { code: "invalid_action" } });
    expect(userMessages).toHaveLength(calls);
    expect(await store.listPlayerInputs(SESSION_ID)).toEqual([]);
    expect(await userRows()).toEqual([]);
    expect(await journalRows()).toEqual([]);
    expect(await store.listTurnResults(SESSION_ID)).toEqual([]);
  });

  describe("interaction answers", () => {
    async function seedInteractions() {
      await store.appendTurnMessage({
        id: "ask",
        sessionId: SESSION_ID,
        turnId: "ask-turn",
        sourceType: "runtime",
        sourcePluginId: NARRATOR,
        role: "assistant",
        content: "",
        order: 5,
        createdAt: AT,
        pendingInput: [
          {
            interactionId: "plan",
            type: "form",
            title: "Plan",
            submitLabel: "Go",
            fields: [{ type: "text", name: "plan", label: "Plan" }],
            narrativeTemplate: "I plan to {{plan}}.",
          },
          {
            interactionId: "path",
            type: "choice",
            prompt: "Which way?",
            choices: [{ id: "left", label: "Left" }],
            narrativeTemplate: "I go {{selectedLabel}}.",
          },
          {
            interactionId: "stance",
            type: "choice",
            prompt: "How do you stand?",
            choices: [{ id: "firm", label: "Firm" }],
            narrativeTemplate: "I stand {{selectedLabel}}.",
            actionKind: "act",
          },
          {
            interactionId: "yield",
            type: "confirmation",
            prompt: "Give way?",
            actionKind: passKind.kind,
          },
        ],
      });
    }
    const form = (fields: Record<string, unknown>) => ({
      kind: "act",
      interaction: { turnId: "ask-turn", interactionId: "plan", type: "form" },
      fields,
    });
    const choice = {
      kind: "say",
      interaction: {
        turnId: "ask-turn",
        interactionId: "path",
        type: "choice",
      },
      fields: { selectedId: "left", selectedLabel: "Left" },
    };

    it("answers a form and a choice in one submission", async () => {
      await seedInteractions();
      const events = await submit({
        actions: [form({ plan: "climb" }), choice],
      });
      expect(events[0]).toMatchObject({
        type: "interaction.submitted",
        payload: {
          interactionTurnId: "ask-turn",
          message: { content: "I plan to climb.\nI go Left." },
        },
      });
      expect(completed(events)).toMatchObject({ committed: true });
      expect(await store.listPlayerInputs(SESSION_ID)).toHaveLength(2);
      // A single player's answers keep their filled narratives.
      expect((await journalRows()).map((message) => message.content)).toEqual([
        "I plan to climb.\nI go Left.",
      ]);
      const [row] = await userRows();
      expect(row?.metadata).toMatchObject({
        actions: [
          {
            seatId: "main",
            kind: "act",
            actorId: "hero",
            text: "I plan to climb.",
            fields: { plan: "climb" },
            interaction: { interactionId: "plan" },
          },
          {
            kind: "say",
            text: "I go Left.",
            interaction: { interactionId: "path" },
          },
        ],
      });
      // The answers are stored: a retry runs again from the recorded actions.
      expect(await startedPayload(events[0]!.turnId)).toMatchObject({
        recoveryAction: { type: "retry_turn", payload: {} },
        playerInput: { messageId: row?.id },
      });
    });

    it("refuses a spectator's form answer and stores nothing", async () => {
      await seedInteractions();
      await setSeats([
        MAIN,
        { id: "watch", controller: "human", role: "spectator", characters: [] },
      ]);
      const response = await post({
        actions: [{ ...form({ plan: "climb" }), seatId: "watch" }],
      });
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({
        code: "action_kind_not_allowed",
      });
      expect(await store.listPlayerInputs(SESSION_ID)).toEqual([]);
    });

    it("refuses an answer submitted as another kind", async () => {
      await seedInteractions();
      const response = await post({ actions: [{ ...choice, kind: "act" }] });
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ code: "invalid_action" });
    });

    it("takes the kind a committed interaction declares instead of the default", async () => {
      await seedInteractions();
      const stance = {
        interaction: {
          turnId: "ask-turn",
          interactionId: "stance",
          type: "choice",
        },
        fields: { selectedId: "firm", selectedLabel: "Firm" },
      };
      const yieldAnswer = {
        kind: passKind.kind,
        interaction: {
          turnId: "ask-turn",
          interactionId: "yield",
          type: "confirmation",
        },
        fields: { confirmed: true },
      };
      // The type's default no longer fits a choice declared as `act`.
      const refused = await post({ actions: [{ ...stance, kind: "say" }] });
      expect(refused.status).toBe(400);
      expect(await refused.json()).toMatchObject({ code: "invalid_action" });
      expect(await store.listPlayerInputs(SESSION_ID)).toEqual([]);

      const events = await submit({
        actions: [{ ...stance, kind: "act" }, yieldAnswer],
      });
      expect(completed(events)).toMatchObject({ committed: true });
      expect((await userRows())[0]?.metadata).toMatchObject({
        actions: [
          { kind: "act", interaction: { interactionId: "stance" } },
          {
            kind: passKind.kind,
            actorId: "hero",
            interaction: { interactionId: "yield" },
          },
        ],
      });
    });

    it("checks a declared plugin kind against the answering seat's role", async () => {
      await seedInteractions();
      await setSeats([
        MAIN,
        { id: "host", controller: "human", role: "host", characters: [] },
      ]);
      const response = await post({
        actions: [
          {
            seatId: "host",
            kind: passKind.kind,
            interaction: {
              turnId: "ask-turn",
              interactionId: "yield",
              type: "confirmation",
            },
            fields: { confirmed: true },
          },
        ],
      });
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({
        code: "action_kind_not_allowed",
      });
    });
  });

  describe("recovery", () => {
    async function interruptedTurn(payload: Record<string, unknown>) {
      await store.addTraceEvent({
        id: crypto.randomUUID(),
        sessionId: SESSION_ID,
        turnId: "old-turn",
        traceId: "old-turn",
        type: "turn.started",
        createdAt: AT,
        payload: { origin: "player", ...payload },
      });
    }
    const recorded: TurnAction[] = [
      {
        seatId: "main",
        kind: "act",
        actorId: "hero",
        text: "I plan to climb.",
        fields: { plan: "climb" },
        interaction: {
          turnId: "ask-turn",
          interactionId: "plan",
          type: "form",
        },
        source: "player",
      },
    ];

    it("rebuilds a retry_turn's actions from the recorded player input", async () => {
      await interruptedTurn({
        recoveryAction: { type: "retry_turn", payload: {} },
        playerInput: { actions: recorded, messageId: "answer-row" },
      });
      const events = await submit(
        { recoverFromTurnId: "old-turn" },
        "retry_turn",
      );
      expect(completed(events)).toMatchObject({ committed: true });
      // The answer is not submitted again: no interaction event, no input row.
      expect(events.map((event) => event.type)).not.toContain(
        "interaction.submitted",
      );
      expect(await store.listPlayerInputs(SESSION_ID)).toEqual([]);
      expect(await userRows()).toMatchObject([
        {
          id: "answer-row",
          content: "I plan to climb.",
          metadata: { actions: recorded },
        },
      ]);
      expect((await journalRows()).map((message) => message.content)).toEqual([
        "I plan to climb.",
      ]);
    });

    it("retries a submission with its resolved actions", async () => {
      const actions = [
        { seatId: "main", kind: "say", actorId: "hero", text: "Again." },
      ];
      await interruptedTurn({
        recoveryAction: {
          type: "submit_actions",
          payload: { actions, inputMessageId: "again-row" },
        },
      });
      const events = await submit({
        actions,
        inputMessageId: "again-row",
        recoverFromTurnId: "old-turn",
      });
      expect(completed(events)).toMatchObject({ committed: true });
      expect(await userRows()).toMatchObject([
        {
          id: "again-row",
          content: "Again.",
          metadata: { actions: [{ ...actions[0], source: "player" }] },
        },
      ]);
      // A changed input no longer matches the recorded retry.
      const changed = await submit({
        actions: [{ kind: "say", text: "Different." }],
        recoverFromTurnId: "old-turn",
      });
      expect(changed.at(-1)).toMatchObject({
        type: "error.occurred",
        payload: { code: "recovery_unavailable" },
      });
    });
  });
});

describe("GET /api/sessions/:id/action-kinds", () => {
  it("lists the base kinds, the session's plugin kinds and each seat's allowed kinds", async () => {
    const store = createMemoryStore();
    const registry = createPluginRegistry();
    registry.register(whisperEntry());
    await store.createSession({
      id: SESSION_ID,
      locale: "en-US",
      phase: "playing",
      status: "active",
      setupRuntimes: {},
      seats: [
        MAIN,
        { id: "host", controller: "human", role: "host", characters: [] },
        { id: "empty", controller: "empty", role: "spectator", characters: [] },
      ],
      metadata: { sessionIncarnationNonce: crypto.randomUUID() },
      activePlugins: [WHISPER_PACK],
      completedPlayerTurns: 0,
      createdAt: AT,
      updatedAt: AT,
    });
    const app = new Hono();
    app.use("*", async (c, next) => {
      c.set("store", store);
      c.set("pluginRegistry", registry);
      await next();
    });
    app.route("/api/sessions", sessionRoutes);
    const response = await app.request(
      `/api/sessions/${SESSION_ID}/action-kinds`,
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as SessionActionKindsResponse;
    expect(body.kinds.map((kind) => kind.kind)).toEqual([
      "say",
      "act",
      "narrate",
      "direct",
      "advance",
      "command",
      whisperKind.kind,
      passKind.kind,
    ]);
    expect(body.kinds[0]).toMatchObject({
      source: "framework",
      roles: ["player"],
      text: "required",
      actor: true,
    });
    expect(body.kinds.slice(-2)).toEqual([whisperKind, passKind]);
    expect(body.seats).toEqual([
      {
        seatId: "main",
        role: "player",
        controller: "human",
        allowed: ["say", "act", "command", whisperKind.kind, passKind.kind],
      },
      {
        seatId: "host",
        role: "host",
        controller: "human",
        allowed: ["narrate", "direct", "advance", "command"],
      },
      { seatId: "empty", role: "spectator", controller: "empty", allowed: [] },
    ]);
    await store.close();
  });
});
