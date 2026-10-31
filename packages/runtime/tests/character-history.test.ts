import { describe, expect, it, vi } from "vitest";
import { createMemoryStore } from "@covel/store/memory";
import { runTurnPipeline } from "../src/turn-executor/turn-executor.js";
import type { CharacterHistory, RuntimeManifest } from "@covel/shared";
import type { MessageRecord } from "@covel/store";
import { CharacterHistoryReader } from "../src/orchestration/character-history.js";

const world = {
  characters: [
    {
      id: "a",
      name: "Mara",
      type: "npc",
      sessionId: "session",
      version: 1,
      createdAt: "2026-01-01",
      updatedAt: "2026-01-01",
    },
    {
      id: "b",
      name: "Ivo",
      type: "npc",
      sessionId: "session",
      version: 1,
      createdAt: "2026-01-01",
      updatedAt: "2026-01-01",
    },
  ],
};
function message(
  text: string,
  presence: unknown = ["a"],
  extra: Partial<MessageRecord> = {},
): MessageRecord {
  return {
    id: text,
    sessionId: "session",
    role: "assistant",
    content: "untrusted raw content",
    createdAt: "2026-01-01",
    metadata: {
      kind: "story",
      presentCharacterIds: presence,
      segments: [{ kind: "dialogue", speaker: "Mara", speakerId: "a", text }],
    },
    ...extra,
  };
}
describe("witnessed stories", () => {
  it("filters presence before taking the tail and strips bookkeeping", async () => {
    const rows = [
      message("older"),
      message("unseen secret", ["b"]),
      message("newer"),
      message("private action", ["a"], { role: "user" }),
      message("other session secret", ["a"], { sessionId: "other" }),
      message("invalid presence", "a"),
    ];
    const reader = new CharacterHistoryReader(
      { listMessagesPage: async () => rows },
      "session",
    );
    const history = await reader.read("a", world, { limit: 1 });
    expect(history).toEqual({
      messages: [
        {
          role: "assistant",
          content: "newer",
          segments: [{ kind: "dialogue", speaker: "Mara", text: "newer" }],
        },
      ],
      truncated: true,
    });
    expect(JSON.stringify(history)).not.toMatch(
      /secret|speakerId|createdAt|untrusted/,
    );
    await expect(reader.read("unknown", world)).rejects.toMatchObject({
      code: "not-found",
    });
    await expect(reader.read("a", world, { limit: 0 })).rejects.toMatchObject({
      code: "invalid-input",
    });
  });
  it("shares one frozen load and does not widen on resume", async () => {
    const rows = [message("before")];
    const load = vi.fn(async () => [...rows]);
    const reader = new CharacterHistoryReader(
      { listMessagesPage: load },
      "session",
    );
    await Promise.all([reader.read("a", world), reader.read("b", world)]);
    rows.push(message("intervening secret"));
    const resumed = new CharacterHistoryReader(
      { listMessagesPage: load },
      "session",
      reader.snapshot(),
    );
    expect(
      (await resumed.read("a", world)).messages.map((row) => row.content),
    ).toEqual(["before"]);
    expect(load).toHaveBeenCalledTimes(1);
  });
  it("reaches the scan and text bounds with whole segments", async () => {
    const rows = Array.from({ length: 200 }, (_, i) =>
      message(String(i).padEnd(4000, "x")),
    );
    const load = vi.fn(async () => rows);
    const reader = new CharacterHistoryReader(
      { listMessagesPage: load },
      "session",
    );
    const history = await reader.read("a", world, { limit: 50 });
    expect(history.messages).toHaveLength(4);
    expect(history.messages[0]?.content).toBe(
      rows[196]?.metadata && String(196).padEnd(4000, "x"),
    );
    expect(history.truncated).toBe(true);
    expect(load).toHaveBeenCalledWith("session", { limit: 200 });
  });
  it("fails closed on non-story and malformed presence, keeping all segments of a witnessed story", async () => {
    const rows = [
      message("empty", []),
      message("missing", undefined, {
        metadata: {
          kind: "story",
          segments: [{ kind: "narration", text: "hidden" }],
        },
      }),
      message("direct", ["a"], {
        metadata: {
          kind: "direct",
          presentCharacterIds: ["a"],
          segments: [{ kind: "narration", text: "hidden" }],
        },
      }),
      ...(["system", "tool", "user"] as const).map((role) =>
        message("excluded", ["a"], { role }),
      ),
      message("witnessed", ["a"], {
        metadata: {
          kind: "story",
          presentCharacterIds: ["a"],
          segments: [
            { kind: "dialogue", speaker: "Unknown name", text: "First" },
            { kind: "narration", text: "Second" },
          ],
        },
      }),
    ];
    const history = await new CharacterHistoryReader(
      { listMessagesPage: async () => rows },
      "session",
    ).read("a", world);
    expect(history.messages).toHaveLength(1);
    expect(history.messages[0]?.content).toBe("First\n\nSecond");
    expect(history.truncated).toBe(false);
  });
  it("keeps the latest whole segments when a single message exceeds the text budget", async () => {
    const segments = Array.from({ length: 5 }, (_, i) => ({
      kind: "action",
      text: `${i}:` + "😀".repeat(1999),
    }));
    const reader = new CharacterHistoryReader(
      {
        listMessagesPage: async () => [
          message("large", ["a"], {
            metadata: { kind: "story", presentCharacterIds: ["a"], segments },
          }),
        ],
      },
      "session",
    );
    const history = await reader.read("a", world);
    expect(history.messages[0]?.segments).toEqual(segments.slice(-3));
    expect(history.messages[0]?.content.length).toBeLessThanOrEqual(16_000);
    expect(history.truncated).toBe(true);
  });
  it("revokes an in-flight history result when its function invocation settles", async () => {
    const store = createMemoryStore();
    const now = "2026-01-01";
    await store.createSession({
      id: "session",
      status: "active",
      phase: "playing",
      locale: "en-US",
      activePlugins: ["sample"],
      seats: [],
      setupRuntimes: {},
      completedPlayerTurns: 0,
      createdAt: now,
      updatedAt: now,
    });
    await store.upsertCharacter(world.characters[0]!);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    vi.spyOn(store, "listMessagesPage").mockImplementation(async () => {
      await gate;
      return [message("POST-REVOCATION-SECRET")];
    });
    const manifest: RuntimeManifest = {
      pluginId: "sample",
      name: "sample/story",
      description: "Story",
      runtimeType: "function",
      outputKind: "story",
      stage: "narrative",
    };
    let read: Promise<CharacterHistory | Error> | undefined;
    const result = await runTurnPipeline(
      {
        sessionId: "session",
        turnId: "turn",
        playerMessage: "Continue",
        origin: "player",
      },
      [manifest],
      {
        store,
        llm: { generate: vi.fn() },
        loadRuntime: async () => ({
          manifest,
          promptTemplate: "",
          handler: async (ctx) => {
            read = ctx
              .historyFor("a")
              .catch((error: unknown) =>
                error instanceof Error ? error : new Error(String(error)),
              );
            return {
              outcome: "success",
              value: { narrativeOutput: "The room is quiet." },
            };
          },
        }),
      },
    );
    expect(result.runtimeResults[0]?.status).toBe("success");
    release();
    const late = await read;
    expect(late).toBeInstanceOf(Error);
    expect(String(late)).toMatch(/completed/i);
    expect(JSON.stringify(late)).not.toContain("POST-REVOCATION-SECRET");
    await store.close();
  });
});

it("bounds the complete actor brief by dropping old history and whole profile fields", async () => {
  const { buildCharacterBrief } =
    await import("../src/orchestration/character-brief.js");
  const newest = `NEWEST-SCENE${"\n".repeat(3900)}`;
  const older = `OLDEST-SCENE${"\n".repeat(3900)}`;
  const history: CharacterHistory = {
    messages: [older, newest].map((content) => ({
      role: "assistant",
      content,
      segments: [{ kind: "narration", text: content }],
    })),
    truncated: false,
  };
  const profile = {
    ...world.characters[0]!,
    fields: { oversized: "PROFILE-SECRET".repeat(2000), title: "Captain" },
  };
  const brief = "B".repeat(20_000);
  const prompt = await buildCharacterBrief(
    profile,
    history,
    brief,
    "I".repeat(2_000),
    "en-US",
  );
  expect(prompt.length).toBeLessThanOrEqual(40_000);
  expect(prompt).not.toMatch(/OLDEST-SCENE|PROFILE-SECRET/);
  expect(prompt).toContain("NEWEST-SCENE");
  expect(prompt).toContain(brief);
  expect(prompt).toContain('"truncated":true');
  expect(
    await buildCharacterBrief(
      { ...profile, fields: "large".repeat(5000) },
      { messages: [], truncated: false },
      brief,
    ),
  ).not.toContain("large".repeat(5000));
});
