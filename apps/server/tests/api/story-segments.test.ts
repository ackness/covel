/**
 * A narrator that answers with story segments, through the API: the stream
 * carries each paragraph's speaker as written, the committed message carries
 * the segments with resolved speakers, the journal and the next turn's
 * history read the joined text, and no character ID reaches model-facing
 * text.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import path from "node:path";
import type { Hono } from "hono";
import type { LLMAdapter, LLMResponse } from "@covel/runtime";
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

const PROSE = "风从海上吹来。\n\n船慢慢离岸。";

/** Answers every narrator request with one segmented story, streamed. */
class SegmentedNarrator implements LLMAdapter {
  requests: { role: string; content: string }[][] = [];
  /** Answer in prose instead of segments. */
  prose = false;
  private answer(params: { messages: readonly LLMMessage[] }): string {
    this.requests.push(
      params.messages.map((message) => ({
        role: message.role,
        content: text(message.content),
      })),
    );
    if (this.prose) return PROSE;
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
      content: this.answer(params),
      toolCalls: [],
      finishReason: "stop",
      usage: { inputTokens: 10, outputTokens: 10 },
    };
  }
  async *stream(
    params: Parameters<NonNullable<LLMAdapter["stream"]>>[0],
  ): AsyncIterable<LLMStreamEvent> {
    for (const textDelta of this.answer(params).match(/.{1,6}/gsu) ?? [])
      yield { type: "text-delta", textDelta };
    yield { type: "done", finishReason: "stop" };
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

const deltaFrames = (events: readonly Frame[]) =>
  events.filter((event) => event.type === "narrative.delta");

describe("segmented stories through the API", () => {
  let boot: Awaited<ReturnType<typeof bootstrapApi>>;
  let app: Hono;
  let llm: SegmentedNarrator;
  let sessionId: string;
  let firstTurn: Frame[];

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

  it("streams each paragraph's kind and written speaker on narrative.delta", async () => {
    const deltas = deltaFrames(firstTurn);
    expect(deltas.length).toBeGreaterThan(0);
    expect(deltas.every((frame) => frame.payload.kind === "story")).toBe(true);
    expect(
      deltas.flatMap((frame) =>
        frame.payload.segment ? [frame.payload.segment] : [],
      ),
    ).toEqual([
      { index: 0, kind: "narration" },
      // The name as written; the committed segment resolves it.
      { index: 1, kind: "dialogue", speaker: "小雅" },
      { index: 2, kind: "dialogue", speaker: "陌生人" },
    ]);
    expect(deltas.map((frame) => frame.payload.delta).join("")).toBe(JOINED);
    const completed = firstTurn.find(
      (frame) => frame.type === "narrative.completed",
    );
    expect(completed?.payload.segments).toEqual(expectedSegments);
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

  it("streams a prose answer with no paragraph metadata", async () => {
    llm.prose = true;
    const deltas = deltaFrames(await turn("req-story-prose", "看海"));
    expect(deltas.length).toBeGreaterThan(0);
    expect(deltas.some((frame) => "segment" in frame.payload)).toBe(false);
  });
});
