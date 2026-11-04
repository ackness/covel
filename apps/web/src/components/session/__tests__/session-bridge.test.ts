// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  initialState,
  reducer,
  configureMessagesWindowCap,
} from "@/stores/session-store/reducer.js";
import type { StreamMessage } from "@/stores/session-store.js";
import {
  buildSessionProjection,
  checkedSessionProjection,
  withCheckedDrafts,
  createSessionMessageOrdinals,
  stripHiddenKeys,
  sessionProjectionSchema,
  type SessionProjectionInput,
  SESSION_BRIDGE_MAX_CHARACTER_BYTES,
  SESSION_BRIDGE_MAX_DRAFTS,
  SESSION_BRIDGE_MAX_MESSAGE_BYTES,
  SESSION_BRIDGE_MAX_TEXT_BYTES,
} from "../session-bridge.js";
import {
  createInteractionHandles,
  publicInteraction,
} from "../session-bridge-interactions.js";

const message = (
  id: string,
  content = "story",
  extra: Partial<StreamMessage> = {},
): StreamMessage => ({
  id,
  content,
  role: "assistant",
  kind: "story",
  timestamp: "secret-time",
  turnId: "secret-turn",
  requestId: "secret-request",
  runtimeId: "secret-runtime",
  ...extra,
});
const input = (
  extra: Partial<SessionProjectionInput> = {},
): SessionProjectionInput => ({
  session: { phase: "playing", completedPlayerTurns: 4 },
  executing: false,
  messages: [],
  messageSeqs: createSessionMessageOrdinals()(extra.messages ?? []),
  submittedBlockIds: new Set(),

  characters: [],
  slots: [],
  ...extra,
});
describe("public session projection", () => {
  it("includes only player-visible story and user messages, without store metadata", () => {
    const result = buildSessionProjection(
      input({
        messages: [
          message("secret-message"),
          message("user-id", "user", { role: "user", kind: undefined }),
          message("system-id", "system", { role: "system" }),
          message("private-id", "reasoning", { kind: "plugin" }),
          message("block-id", "block", { role: "user", block: {} }),
        ],
      }),
    );
    expect(result.messages.map((item) => item.text)).toEqual(["story", "user"]);
    const json = JSON.stringify(result);
    for (const key of [
      "secret-message",
      "timestamp",
      "turnId",
      "requestId",
      "runtimeId",
      "reasoning",
      "private-id",
    ])
      expect(json).not.toContain(key);
    expect(result.turn).toBe(4);
    expect(sessionProjectionSchema.safeParse(result).success).toBe(true);
  });
  it("accepts only version 4 complete state with no streaming field", () => {
    const result = buildSessionProjection(
      input({ messages: [message("one")] }),
    );
    expect(result.version).toBe(4);
    expect(result.drafts).toEqual([]);
    expect(result).not.toHaveProperty("streaming");
    for (const version of [2, 3])
      expect(
        sessionProjectionSchema.safeParse({ ...result, version }).success,
      ).toBe(false);
    expect(
      sessionProjectionSchema.safeParse({ ...result, streaming: null }).success,
    ).toBe(false);
  });
  it("gives a story's segments as display lines only when they spell out its text", () => {
    const segmented = {
      ...message("lines", "Rain.\n\n“Go.”"),
      segments: [
        { kind: "narration" as const, text: "Rain." },
        {
          kind: "dialogue" as const,
          text: "“Go.”",
          speaker: "Aya",
          speakerId: "char-aya",
        },
      ],
    };
    const stale = { ...segmented, id: "stale", content: "Edited text" };
    const result = buildSessionProjection(
      input({ messages: [segmented, stale, message("plain")] }),
    );
    expect(sessionProjectionSchema.safeParse(result).success).toBe(true);
    expect(result.messages.map((m) => m.lines)).toEqual([
      [
        { kind: "narration", text: "Rain." },
        {
          kind: "dialogue",
          text: "“Go.”",
          speaker: "Aya",
          speakerId: "char-aya",
        },
      ],
      undefined,
      undefined,
    ]);
  });
  it("bounds drafts by count and size", () => {
    const long = "雨".repeat(SESSION_BRIDGE_MAX_MESSAGE_BYTES);
    const drafts = Array.from(
      { length: SESSION_BRIDGE_MAX_DRAFTS + 2 },
      (_, i) => ({
        turnId: `turn-${i}`,
        runtimeId: "narrator",
        pluginId: "narrator",
        draftId: `d${i}`,
        units: [{ text: i === 0 ? long : `Line ${i}` }],
        accepted: false,
        revising: false,
      }),
    );
    const result = buildSessionProjection(input({ drafts }));
    expect(sessionProjectionSchema.safeParse(result).success).toBe(true);
    expect(result.drafts).toHaveLength(SESSION_BRIDGE_MAX_DRAFTS);
    expect(result.drafts[0]?.truncated).toBe(true);
    expect(
      new TextEncoder().encode(result.drafts[0]!.text).length,
    ).toBeLessThanOrEqual(SESSION_BRIDGE_MAX_MESSAGE_BYTES);
    expect(result.drafts[1]).toEqual({ state: "writing", text: "Line 1" });
  });
  it("checks a projection once and only the drafts of a checked one", () => {
    const built = buildSessionProjection(input({ messages: [message("a")] }));
    const checked = checkedSessionProjection(built)!;
    expect(checked).toBeDefined();
    expect(checkedSessionProjection(checked)).toBe(checked);
    expect(checkedSessionProjection({ ...checked, extra: 1 })).toBeUndefined();

    const next = withCheckedDrafts(checked, [
      { state: "writing", text: "Hi" },
    ])!;
    expect(next.messages).toBe(checked.messages);
    expect(checkedSessionProjection(next)).toBe(next);
    expect(withCheckedDrafts(checked, [{ state: "lost", text: "" }])).toBe(
      undefined,
    );
    // An object that was never checked is not trusted for its other fields.
    expect(withCheckedDrafts({ ...checked }, [])).toBeUndefined();
  });
  it("keeps the newest messages that fit the byte budget, in order", () => {
    const big = "x".repeat(SESSION_BRIDGE_MAX_MESSAGE_BYTES - 1024);
    const count = Math.ceil(SESSION_BRIDGE_MAX_TEXT_BYTES / big.length) + 3;
    const messages = Array.from({ length: count }, (_, index) =>
      message(String(index), `${index}${big}`),
    );
    const result = buildSessionProjection(input({ messages }));
    expect(sessionProjectionSchema.safeParse(result).success).toBe(true);
    const bytes = result.messages.reduce((sum, m) => sum + m.text.length, 0);
    expect(bytes).toBeLessThanOrEqual(SESSION_BRIDGE_MAX_TEXT_BYTES);
    // One more would not fit.
    expect(bytes + big.length).toBeGreaterThan(SESSION_BRIDGE_MAX_TEXT_BYTES);
    const seqs = result.messages.map((m) => m.seq);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    expect(seqs.at(-1)).toBe(count);
  });
  it("keeps full visible sequence numbers when the 200-message window slides", () => {
    const result = buildSessionProjection(
      input({
        messages: Array.from({ length: 205 }, (_, index) =>
          message(String(index)),
        ),
      }),
    );
    expect(result.messages).toHaveLength(200);
    expect(result.messages[0]?.seq).toBe(6);
  });
  it("keeps surviving ordinals across host eviction and restores evicted history identities", () => {
    configureMessagesWindowCap(200);
    try {
      const assign = createSessionMessageOrdinals();
      const initial = Array.from({ length: 200 }, (_, index) =>
        message(`m${index + 1}`, `Story ${index + 1}`, {
          requestId: undefined,
          timestamp: "2026-10-29T00:00:00Z",
        }),
      );
      const snapshot = (messages: readonly StreamMessage[]) =>
        buildSessionProjection(
          input({ messages, messageSeqs: assign(messages) }),
        );
      const before = snapshot(initial);
      const grown = reducer(
        { ...initialState, messages: initial },
        { type: "ADD_MESSAGE", message: message("m201", "Story 201") },
      );
      expect(grown.messages).toHaveLength(200);
      const after = snapshot(grown.messages);
      expect(after.messages.map((row) => row.seq)).toEqual(
        Array.from({ length: 200 }, (_, index) => index + 2),
      );
      expect(after.messages.slice(0, -1)).toEqual(before.messages.slice(1));
      expect(after.messages.at(-1)).toMatchObject({
        seq: 201,
        text: "Story 201",
      });
      // Fetching an evicted ID again must not allocate a different identity.
      const restored = snapshot(initial.slice(0, 2));
      expect(restored.messages.map((row) => row.seq)).toEqual([1, 2]);
    } finally {
      configureMessagesWindowCap(0);
    }
  });
  it("keeps existing ordinals when older history is prepended and never reuses them", () => {
    const assign = createSessionMessageOrdinals();
    const current = [message("current-a", "A"), message("current-b", "B")];
    const before = buildSessionProjection(
      input({ messages: current, messageSeqs: assign(current) }),
    );
    const prepended = reducer(
      { ...initialState, messages: current },
      {
        type: "PREPEND_MESSAGES",
        messages: [
          message("older-a", "Older A"),
          message("older-b", "Older B"),
        ],
        cursor: null,
      },
    ).messages;
    const after = buildSessionProjection(
      input({ messages: prepended, messageSeqs: assign(prepended) }),
    );
    expect(after.messages.slice(2)).toEqual(before.messages);
    expect(after.messages.map((row) => row.text)).toEqual([
      "Older A",
      "Older B",
      "A",
      "B",
    ]);
    expect(new Set(after.messages.map((row) => row.seq)).size).toBe(4);
    expect(after.messages.slice(0, 2).map((row) => row.seq)).toEqual([3, 4]);
  });
  it("keeps durable ordinals across repeated completion and identical-runtime messages", () => {
    const assign = createSessionMessageOrdinals();
    const first = [message("saved", "Full story")];
    const before = buildSessionProjection(
      input({ messages: first, messageSeqs: assign(first) }),
    );
    const second = [...first, message("next", "Next story")];
    const after = buildSessionProjection(
      input({ messages: second, messageSeqs: assign(second) }),
    );
    expect(after.messages[0]?.seq).toBe(before.messages[0]?.seq);
    expect(after.messages[1]?.seq).not.toBe(before.messages[0]?.seq);
  });
  it("enforces UTF-8 byte limits on individual and total committed text", () => {
    const result = buildSessionProjection(
      input({
        messages: Array.from({ length: 12 }, (_, index) =>
          message(String(index), "字".repeat(12000)),
        ),
      }),
    );
    expect(result.messages).toHaveLength(8);
    expect(result.messages[0]?.seq).toBe(5);
    expect(
      result.messages.every(
        (item) =>
          item.truncated && new TextEncoder().encode(item.text).length <= 32768,
      ),
    ).toBe(true);
    expect(result).not.toHaveProperty("streaming");
  });
  it("selects unanswered interaction blocks and sanitises nested values", () => {
    const result = buildSessionProjection(
      input({
        messages: [
          message("answered", "", { block: { type: "interactive_choice" } }),
          message("user", "answer", { role: "user" }),
          message("pending", "", {
            kind: "plugin",
            block: {
              type: "interactive_form",
              _hidden: "private",
              data: {
                hidden: "private",
                fields: [
                  {
                    name: "public",
                    label: "Public",
                    type: "text",
                    runtimeId: "private",
                  },
                ],
              },
            },
          }),
          message("submitted", "", {
            kind: "plugin",
            block: { type: "interactive_choice" },
          }),
        ],
        submittedBlockIds: new Set(["submitted"]),
      }),
    );
    expect(result.pending).toEqual([
      {
        seq: 3,
        interaction: {
          type: "form",
          fields: [{ name: "public", label: "Public", type: "text" }],
        },
      },
    ]);
  });
  it("bounds pending blocks and withholds handles only for interactions over the byte limit", () => {
    const handles = createInteractionHandles();
    const choice = (id: string, length: number) =>
      message(id, "", {
        kind: "plugin",
        block: {
          type: "interactive_choice",
          data: { choices: [{ id: "left", label: "字".repeat(length) }] },
        },
      });
    const small = choice("small", 5000);
    const large = choice("large", 6000);
    for (const item of [small, large])
      expect(publicInteraction(item.block!).type).toBe("choice");
    expect(
      new TextEncoder().encode(JSON.stringify(publicInteraction(small.block!)))
        .length,
    ).toBeLessThan(16384);
    expect(
      new TextEncoder().encode(JSON.stringify(publicInteraction(large.block!)))
        .length,
    ).toBeGreaterThan(16384);
    const messages = [
      small,
      large,
      ...Array.from({ length: 10 }, (_, index) => choice(String(index), 5000)),
    ];
    const result = buildSessionProjection(
      input({
        messages,
        interactionHandle: handles.issue,
      }),
    );
    expect(result.pending).toHaveLength(8);
    const handle = result.pending[0]?.handle;
    expect(handle).toEqual(expect.any(String));
    expect(handles.resolve(handle!, messages, new Set())).toMatchObject({
      blockId: "small",
      type: "choice",
    });
    expect(result.pending[1]?.interaction).toEqual({ type: "unavailable" });
    expect(result.pending[1]).not.toHaveProperty("handle");
  });
  it("removes all reserved keys recursively and cuts values beyond depth 8", () => {
    expect(
      stripHiddenKeys({
        _hidden: 1,
        _x: 1,
        hidden: 1,
        concealed: 1,
        turnId: 1,
        requestId: 1,
        runtimeId: 1,
        sessionId: 1,
        timestamp: 1,
        createdAt: 1,
        updatedAt: 1,
        uuid: 1,
        nested: [{ _x: 1, shown: true }],
      }),
    ).toEqual({ nested: [{ shown: true }] });
    let value: unknown = "deep";
    for (let index = 0; index < 9; index++) value = { child: value };
    expect(JSON.stringify(stripHiddenKeys(value))).not.toContain("deep");
    expect(stripHiddenKeys("value", 9)).toBeNull();
  });
  it("allow lists public characters, drops invalid/oversized records and caps the count", () => {
    const character = {
      id: "public-id",
      name: "Name",
      type: "npc",
      aliases: ["Alias"],
      description: "Known",
      fields: { visible: 3, _secret: 4 },
      privateData: "secret",
    };
    const result = buildSessionProjection(
      input({
        characters: [
          { name: "No id" },
          { id: 4, name: "Wrong", type: "npc" },
          {
            ...character,
            description: "x".repeat(SESSION_BRIDGE_MAX_CHARACTER_BYTES),
          },
          ...Array.from({ length: 110 }, () => character),
        ],
        slots: [
          {
            slot: "stage.backdrop@1",
            value: {
              ref: { id: "a".repeat(64), mime: "image/png", size: 1 },
              _hidden: "private",
            },
          },
        ],
      }),
    );
    expect(result.characters).toHaveLength(100);
    expect(result.characters[0]).toEqual({
      id: "public-id",
      name: "Name",
      type: "npc",
      aliases: ["Alias"],
      description: "Known",
    });
    expect(result.slots).toEqual([
      {
        slot: "stage.backdrop@1",
        value: { ref: { id: "a".repeat(64), mime: "image/png", size: 1 } },
      },
    ]);
    expect(sessionProjectionSchema.safeParse(result).success).toBe(true);
  });
});
