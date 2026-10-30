import { beforeEach, describe, expect, it } from "vitest";
import { createMemoryStore } from "@covel/store/memory";
import type { RuntimeEffects, SessionEvent } from "@covel/shared";
import { createCommitPipeline } from "../src/session/session-kernel.js";
import { normalizeOutput } from "../src/commit/session-output-normalizer.js";
import { normalizeStoryOutput } from "../src/agent-loop/story-output.js";

const SESSION = "sess-story";
const source = { pluginId: "teller", runtimeId: "teller" };

async function seed() {
  const store = createMemoryStore();
  const now = new Date().toISOString();
  await store.createSession({
    id: SESSION,
    locale: "zh-CN",
    status: "active",
    phase: "playing",
    activePlugins: ["teller"],
    setupRuntimes: {},
    seats: [
      { id: "main", controller: "human", role: "player", characters: "auto" },
    ],
    completedPlayerTurns: 0,
    createdAt: now,
    updatedAt: now,
  });
  const character = (id: string, name: string, aliases?: string[]) =>
    store.upsertCharacter({
      id,
      sessionId: SESSION,
      name,
      ...(aliases ? { aliases } : {}),
      type: "npc",
      version: 1,
      createdAt: now,
      updatedAt: now,
    });
  await character("char-aya", "阿雅", ["小雅"]);
  await character("char-chen", "陈远");
  await character("char-guard-1", "守卫");
  await character("char-guard-2", "守卫");
  return store;
}

/** Commit one runtime output through the ordinary story path. */
async function commitStory(
  store: Awaited<ReturnType<typeof seed>>,
  output: Record<string, unknown>,
  outputKind = "story",
  effects: RuntimeEffects = {},
) {
  const proposals = normalizeOutput(
    output,
    source,
    "turn-1",
    SESSION,
    outputKind,
    effects,
  );
  const results = await createCommitPipeline(store).commitAll(proposals);
  const messages = await store.listMessages(SESSION);
  return {
    message: messages.at(-1)!,
    event: results[0]?.event as SessionEvent | undefined,
  };
}

describe("committing a segmented story", () => {
  let store: Awaited<ReturnType<typeof seed>>;
  beforeEach(async () => {
    store = await seed();
  });

  const story = normalizeStoryOutput({
    segments: [
      { kind: "dialogue", speaker: "小雅", text: "「走吧。」" },
      { kind: "narration", text: "雨停了。" },
      { kind: "dialogue", speaker: "守卫", text: "「站住。」" },
      { kind: "action", speaker: "陌生人", text: "陌生人退后一步。" },
    ],
    cues: { present: ["陈远", "陌生人"] },
  })!;

  it("resolves exact names and aliases and keeps other names as written", async () => {
    const { message } = await commitStory(store, story);
    const metadata = message.metadata as Record<string, unknown>;
    expect(message.content).toBe(story.narrativeOutput);
    expect(metadata.segments).toEqual([
      {
        kind: "dialogue",
        speaker: "阿雅",
        speakerId: "char-aya",
        text: "「走吧。」",
      },
      { kind: "narration", text: "雨停了。" },
      { kind: "dialogue", speaker: "守卫", text: "「站住。」" },
      { kind: "action", speaker: "陌生人", text: "陌生人退后一步。" },
    ]);
    expect(metadata.cues).toEqual({ present: ["陈远", "陌生人"] });
    expect(metadata.yield).toBe("user");
  });

  it("records who was present in order of first mention", async () => {
    const { message } = await commitStory(store, story);
    expect(
      (message.metadata as Record<string, unknown>).presentCharacterIds,
    ).toEqual(["char-aya", "char-chen"]);
  });

  it("traces names that matched no character or more than one", async () => {
    const { event } = await commitStory(store, story);
    expect(event?.type).toBe("narrative.completed");
    expect(event?.payload.unresolvedSpeakers).toEqual(["守卫", "陌生人"]);
  });

  it("adds no story keys to a system message and derives segments for a bare story", async () => {
    const system = await commitStory(store, {}, "system", {
      notifications: [{ message: "系统通知。" }],
    });
    expect(system.message.metadata).toEqual({
      turnId: "turn-1",
      runtimeId: "teller",
      kind: "system",
    });
    const { message, event } = await commitStory(store, {
      narrativeOutput: "第一段。\n\n第二段。",
    });
    expect(message.metadata).toMatchObject({
      kind: "story",
      segments: [
        { kind: "narration", text: "第一段。" },
        { kind: "narration", text: "第二段。" },
      ],
      presentCharacterIds: [],
    });
    expect(event?.payload).not.toHaveProperty("unresolvedSpeakers");
  });
});
