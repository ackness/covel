// @vitest-environment node
import { describe, expect, it } from "vitest";
import type { StreamMessage } from "@/stores/session-store.js";
import {
  buildSessionProjection,
  stripHiddenKeys,
  sessionProjectionSchema,
  type SessionProjectionInput,
  SESSION_BRIDGE_MAX_CHARACTER_BYTES,
} from "../session-bridge.js";

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
  submittedBlockIds: new Set(),
  streamingText: undefined,
  characters: [],
  slots: [],
  ...extra,
});
describe("read-only session projection", () => {
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
  it("puts the placeholder only in streaming and reads the live text", () => {
    const result = buildSessionProjection(
      input({
        messages: [message("one"), message("stream_secret", "old")],
        streamingText: "new",
      }),
    );
    expect(result.messages).toHaveLength(1);
    expect(result.streaming).toEqual({ seq: 2, text: "new" });
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
  it("enforces UTF-8 byte limits on individual, total and streaming text", () => {
    const result = buildSessionProjection(
      input({
        messages: Array.from({ length: 12 }, (_, index) =>
          message(String(index), "字".repeat(12000)),
        ).concat(message("stream_x")),
        streamingText: "x".repeat(70000),
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
    expect(result.streaming?.text.length).toBe(65536);
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
                fields: [{ name: "public", runtimeId: "private" }],
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
        block: {
          type: "interactive_form",
          data: { fields: [{ name: "public" }] },
        },
      },
    ]);
  });
  it("bounds pending blocks and replaces an oversized block", () => {
    const result = buildSessionProjection(
      input({
        messages: Array.from({ length: 12 }, (_, index) =>
          message(String(index), "", {
            kind: "plugin",
            block: { type: "interactive_choice", content: "x".repeat(17000) },
          }),
        ),
      }),
    );
    expect(result.pending).toHaveLength(8);
    expect(result.pending[0]?.block).toEqual({ truncated: true });
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
            value: { ref: { type: "media", id: "opaque" }, _hidden: "private" },
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
      fields: { visible: 3 },
    });
    expect(result.slots).toEqual([
      {
        slot: "stage.backdrop@1",
        value: { ref: { type: "media", id: "opaque" } },
      },
    ]);
    expect(sessionProjectionSchema.safeParse(result).success).toBe(true);
  });
});
