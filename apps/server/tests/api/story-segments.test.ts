/** Committed story segments and progress through the socket-free API. */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import path from "node:path";
import type { Hono } from "hono";
import {
  createHookPipeline,
  type LLMAdapter,
  type LLMResponse,
} from "@covel/runtime";
import type {
  LLMMessage,
  LLMMessageContent,
  LLMStreamEvent,
} from "@covel/shared";
import { createMemoryStore } from "@covel/store/memory";
import { bootstrapApi } from "../../src/routes/api/bootstrap.js";
import { closeTestApi } from "../helpers/close-api.js";

const PLUGINS_DIR = path.resolve(import.meta.dirname, "../../../../plugins");
const AYA_ID = "char-aya-7f3a";

const text = (content: LLMMessageContent): string =>
  typeof content === "string"
    ? content
    : content.map((part) => (part.type === "text" ? part.text : "")).join("");

/** Answers every narrator request with one segmented story, streamed in pieces. */
class SegmentedNarrator implements LLMAdapter {
  requests: { role: string; content: string }[][] = [];
  rejectNext = false;
  private answer(params: { messages: readonly LLMMessage[] }): string {
    this.requests.push(
      params.messages.map((message) => ({
        role: message.role,
        content: text(message.content),
      })),
    );
    if (this.rejectNext) {
      this.rejectNext = false;
      // Readable as it streams, but "aside" is not a segment kind.
      return JSON.stringify({ segments: [{ kind: "aside", text: "草稿。" }] });
    }
    return JSON.stringify({
      segments: [
        { kind: "narration", text: "雨停了，港口的灯一盏盏亮起。" },
        { kind: "dialogue", speaker: "小雅", text: "「走吧，船要开了。」" },
        { kind: "dialogue", speaker: "陌生人", text: "「等等！」" },
      ],
      cues: { present: ["阿雅", "陌生人"] },
    });
  }
  async generate(
    params: Parameters<LLMAdapter["generate"]>[0],
  ): Promise<LLMResponse> {
    return {
      content: null,
      toolCalls: [
        { id: "submit", name: "submit-output", arguments: this.answer(params) },
      ],
      finishReason: "tool_calls",
      usage: { inputTokens: 10, outputTokens: 10 },
    };
  }
  async *stream(
    params: Parameters<NonNullable<LLMAdapter["stream"]>>[0],
  ): AsyncIterable<LLMStreamEvent> {
    const args = this.answer(params);
    for (let at = 0; at < args.length; at += 16)
      yield {
        type: "tool-argument-delta",
        index: 0,
        ...(at === 0 ? { id: "submit", name: "submit-output" } : {}),
        argumentsDelta: args.slice(at, at + 16),
      };
    yield {
      type: "tool-call",
      id: "submit",
      name: "submit-output",
      arguments: args,
    };
    yield { type: "done", finishReason: "tool_calls" };
  }
}

interface Frame {
  readonly type: string;
  readonly payload: Record<string, unknown>;
}

const JOINED =
  "雨停了，港口的灯一盏盏亮起。\n\n「走吧，船要开了。」\n\n「等等！」";

async function frames(res: Response): Promise<Frame[]> {
  return (await res.text())
    .split("\n")
    .filter((line) => line.startsWith("data: "))
    .map((line) => JSON.parse(line.slice(6)) as Frame);
}

describe("segmented stories through the API", () => {
  let boot: Awaited<ReturnType<typeof bootstrapApi>>;
  let app: Hono;
  let llm: SegmentedNarrator;
  let sessionId: string;
  let firstTurn: Frame[];
  let rejectCommit = false;
  const committedReadbacks: Promise<boolean>[] = [];
  const hooks = createHookPipeline();
  hooks.register({
    id: "story-commit",
    event: "PreStateCommit",
    handler: async () =>
      rejectCommit
        ? { action: "abort", reason: "Commit refused." }
        : { action: "continue" },
  });

  const turn = async (requestId: string, words: string) => {
    const res = await app.request("/api/actions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        requestId,
        type: "submit_actions",
        sessionId,
        payload: { actions: [{ kind: "say", text: words }] },
      }),
    });
    expect(res.status).toBe(200);
    return frames(res);
  };

  beforeAll(async () => {
    llm = new SegmentedNarrator();
    boot = await bootstrapApi({
      pluginsDir: PLUGINS_DIR,
      llmAdapter: llm,
      store: createMemoryStore(),
      storeBackend: "memory",
      perRequestMiddleware: [
        async (c, next) => {
          c.set("hookPipeline", hooks);
          await next();
        },
      ],
    });
    app = boot.app;
    boot.registry.syncSessionActivations("__global__", ["narrator"]);
    const created = await app.request("/api/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        locale: "zh-CN",
        plugins: ["narrator"],
        // Explicit requests still include default plugins. This adapter only
        // implements narration, and the history assertion must inspect it.
        excludedPlugins: [...boot.registry.getAll().keys()].filter(
          (pluginId) => pluginId !== "narrator",
        ),
      }),
    });
    expect(created.status).toBe(201);
    sessionId = ((await created.json()) as { id: string }).id;
    const session = (await boot.store.getSession(sessionId))!;
    expect(session.activePlugins).toEqual(["narrator"]);
    const now = new Date().toISOString();
    await boot.store.upsertCharacterSchema({
      sessionId,
      version: 1,
      types: ["npc", "companion"],
      attributes: [],
      createdAt: now,
      updatedAt: now,
    });
    await boot.store.upsertCharacter({
      id: AYA_ID,
      sessionId,
      name: "阿雅",
      aliases: ["小雅"],
      type: "npc",
      version: 1,
      createdAt: now,
      updatedAt: now,
    });
    await boot.store.updateSession(sessionId, {
      phase: "playing",
      completedPlayerTurns: 0,
      setupRuntimes: Object.fromEntries(
        Object.entries(session.setupRuntimes).map(([runtimeId, state]) => [
          runtimeId,
          {
            state: "done" as const,
            resolution: "completed" as const,
            generation: state.generation,
            attempts: Math.max(1, state.attempts),
            completedAt: now,
            pluginVersion: state.pluginVersion,
          },
        ]),
      ),
      updatedAt: now,
    });
    boot.eventBus.onEmit((event) => {
      if (event.type === "narrative.completed" && event.sessionId === sessionId)
        committedReadbacks.push(
          boot.store
            .listMessages(sessionId)
            .then((messages) =>
              messages.some(
                (message) =>
                  message.id === event.payload.messageId &&
                  message.content === event.payload.content,
              ),
            ),
        );
    });
    firstTurn = await turn("req-story-1", "跟上阿雅");
  });

  afterAll(async () => {
    await closeTestApi(boot);
    await boot.store.close();
  });

  const expectedSegments = [
    { kind: "narration", text: "雨停了，港口的灯一盏盏亮起。" },
    {
      kind: "dialogue",
      speaker: "阿雅",
      speakerId: AYA_ID,
      text: "「走吧，船要开了。」",
    },
    { kind: "dialogue", speaker: "陌生人", text: "「等等！」" },
  ];

  it("shows the story as drafts, then one complete story with resolved speakers after durable commit", async () => {
    expect(firstTurn.some((frame) => frame.type === "narrative.delta")).toBe(
      false,
    );
    expect(firstTurn.some((frame) => frame.type === "step.started")).toBe(true);
    expect(firstTurn.some((frame) => frame.type === "tool.completed")).toBe(
      true,
    );
    const completed = firstTurn.filter(
      (frame) => frame.type === "narrative.completed",
    );
    expect(completed).toHaveLength(1);
    expect(completed[0]?.payload).toMatchObject({
      content: JOINED,
      segments: expectedSegments,
    });
    expect(
      firstTurn.find((frame) => frame.type === "execution.completed")?.payload
        .committed,
    ).toBe(true);
    const storyAt = firstTurn.findIndex(
      (frame) => frame.type === "narrative.completed",
    );
    const beforeStory = firstTurn.slice(0, storyAt);
    // Story text arrives early only as drafts, unit by unit, never as raw
    // tool arguments.
    const drafts = beforeStory.filter((frame) => frame.type === "output.draft");
    expect(
      drafts.map((frame) =>
        (frame.payload.units as { text: string }[]).map((unit) => unit.text),
      ),
    ).toEqual([
      ["雨停了，港口的灯一盏盏亮起。"],
      ["雨停了，港口的灯一盏盏亮起。", "「走吧，船要开了。」"],
      ["雨停了，港口的灯一盏盏亮起。", "「走吧，船要开了。」", "「等等！」"],
    ]);
    expect(drafts[1]?.payload).toMatchObject({
      runtimeId: "narrator",
      pluginId: "narrator",
      mode: "units",
      units: [
        { meta: { kind: "narration" } },
        { meta: { kind: "dialogue", speaker: "小雅" } },
      ],
    });
    const accepted = beforeStory.filter(
      (frame) => frame.type === "output.accepted",
    );
    expect(accepted).toHaveLength(1);
    expect(accepted[0]?.payload.draftId).toBe(drafts[0]?.payload.draftId);
    const others = beforeStory.filter(
      (frame) =>
        frame.type !== "output.draft" && frame.type !== "output.accepted",
    );
    expect(JSON.stringify(others)).not.toContain("雨停了，港口");
    expect(JSON.stringify(beforeStory)).not.toContain('"arguments"');
    expect(firstTurn.some((frame) => frame.type === "output.retracted")).toBe(
      false,
    );
    expect(firstTurn.some((frame) => frame.type === "message.completed")).toBe(
      false,
    );
    expect(await Promise.all(committedReadbacks)).toEqual([true]);
  });

  it("returns the segments with names and resolved IDs on /messages and /view", async () => {
    const { items: messages } = (await (
      await app.request(`/api/sessions/${sessionId}/messages`)
    ).json()) as {
      items: { content: string; kind?: string; segments?: unknown }[];
    };
    const story = messages.filter((message) => message.kind === "story").at(-1);
    expect(story?.content).toBe(JOINED);
    expect(story?.segments).toEqual(expectedSegments);

    const view = (await (
      await app.request(`/api/sessions/${sessionId}/view`)
    ).json()) as {
      messages: { content: string; kind?: string; segments?: unknown }[];
    };
    expect(
      view.messages.filter((message) => message.kind === "story").at(-1)
        ?.segments,
    ).toEqual(expectedSegments);
  });

  it("journals the joined text with no character ID", async () => {
    const journal = (await boot.store.listTurnMessages(sessionId))
      .filter((message) => message.sourceRuntimeId === "narrator")
      .at(-1);
    expect(journal?.content).toBe(JOINED);
    expect(JSON.stringify(journal)).not.toContain(AYA_ID);
  });

  it("puts only the joined text in the next turn's history", async () => {
    await turn("req-story-2", "上船");
    const history = llm.requests.at(-1)!;
    const replayed = history.filter(
      (message) => message.role === "assistant" && message.content === JOINED,
    );
    expect(replayed).toHaveLength(1);
    expect(
      history.some(
        (message) =>
          message.role === "assistant" &&
          message.content.includes('"segments"'),
      ),
    ).toBe(false);
    expect(JSON.stringify(history)).not.toContain(AYA_ID);
  });

  it("reports a safe rejection note, retracts its draft, then publishes only the accepted story", async () => {
    llm.rejectNext = true;
    const events = await turn("req-story-revise", "看海");
    const rejection = events.find((frame) => frame.type === "step.completed");
    expect(rejection?.payload.notes).toEqual([
      { kind: "output-rejected", reason: "invalid-output", attempt: 1 },
    ]);
    expect(events.some((frame) => frame.type === "narrative.delta")).toBe(
      false,
    );
    const drafting = events
      .filter((frame) => frame.type.startsWith("output."))
      .map((frame) =>
        frame.type === "output.retracted"
          ? `retracted ${String(frame.payload.reason)}`
          : `${frame.type.slice(7)} ${(frame.payload.units as { text: string }[]).length}`,
      );
    expect(drafting[0]).toBe("draft 1");
    expect(drafting[1]).toBe("retracted revising");
    expect(drafting.at(-1)).toBe("accepted 3");
    expect(
      events.filter((frame) => frame.type === "narrative.completed"),
    ).toHaveLength(1);
  });

  it("withholds accepted output when the real commit is rejected", async () => {
    rejectCommit = true;
    const before = await boot.store.listMessages(sessionId);
    try {
      const events = await turn("req-story-rollback", "上岸");
      // The runtime accepted the story, but only a commit makes it one; the
      // client drops drafts when the execution ends uncommitted.
      expect(events.some((frame) => frame.type === "output.accepted")).toBe(
        true,
      );
      expect(events.some((frame) => frame.type.startsWith("narrative."))).toBe(
        false,
      );
      expect(
        events.find((frame) => frame.type === "execution.completed")?.payload
          .committed,
      ).toBe(false);
      expect(await boot.store.listMessages(sessionId)).toEqual(before);
    } finally {
      rejectCommit = false;
    }
  });

  it("delivers a new session's opening as one committed story", async () => {
    const created = await app.request("/api/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        locale: "zh-CN",
        plugins: ["narrator"],
        excludedPlugins: [...boot.registry.getAll().keys()].filter(
          (id) => id !== "narrator",
        ),
      }),
    });
    expect(created.status).toBe(201);
    const openingId = ((await created.json()) as { id: string }).id;
    const response = await app.request("/api/actions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        requestId: "req-opening",
        type: "start_session",
        sessionId: openingId,
        payload: {},
      }),
    });
    expect(response.status).toBe(200);
    const events = await frames(response);
    const stories = events.filter(
      (event) => event.type === "narrative.completed",
    );
    expect(stories).toHaveLength(1);
    expect(events.some((event) => event.type === "narrative.delta")).toBe(
      false,
    );
    expect(
      events.find((event) => event.type === "execution.completed")?.payload
        .committed,
    ).toBe(true);
    expect(
      (await boot.store.listMessages(openingId))
        .filter((message) => message.role === "assistant")
        .map((message) => message.content),
    ).toEqual([JOINED]);
    expect((await boot.store.getSession(openingId))?.completedPlayerTurns).toBe(
      0,
    );
  });
});
