import { describe, expect, it } from "vitest";
import { estimateMessageTokens } from "@covel/context";
import type { LLMMessage } from "@covel/shared";
import { createLoopContextPolicy } from "../src/agent-loop/loop-context-policy.js";
import { expectMatchedToolCalls } from "./_helpers/agent-loop-fixture.js";

const estimator = (text: string) => text.length;
const tokens = (messages: readonly LLMMessage[]) =>
  messages.reduce(
    (sum, message) => sum + estimateMessageTokens(message, estimator),
    0,
  );
const context = (
  inputLimit: number,
  mode: "normal" | "emergency" = "normal",
) => ({
  inputLimit,
  fixedTokens: 0,
  estimator,
  mode,
});
function group(index: number, size = 1_200, args = "{}"): LLMMessage[] {
  const id = `call-${index}`;
  return [
    {
      role: "assistant",
      content: "scratch",
      reasoningContent: "reasoning",
      toolCalls: [{ id, name: "read", arguments: args }],
    },
    {
      role: "tool",
      toolCallId: id,
      content: JSON.stringify({
        summary: `read page ${index}`,
        data: "x".repeat(size),
        staged: true,
        error: { code: "EMPTY" },
      }),
    },
  ];
}
const transcript = (count: number, size = 1_200, args = "{}") =>
  Array.from({ length: count }, (_, index) => group(index, size, args)).flat();

const repeatedIds = (messages: readonly LLMMessage[]) =>
  messages.map((message) => ({
    ...message,
    ...(message.toolCalls
      ? {
          toolCalls: message.toolCalls.map((call) => ({
            ...call,
            id: "reused",
          })),
        }
      : {}),
    ...(message.toolCallId ? { toolCallId: "reused" } : {}),
  }));

function fit(
  policy: ReturnType<typeof createLoopContextPolicy>,
  messages: readonly LLMMessage[],
  limit: number,
  mode: "normal" | "emergency" = "normal",
) {
  const result = policy.fit(messages, context(limit, mode));
  expectMatchedToolCalls(result.messages);
  return result;
}

describe("loop context policy", () => {
  it.each(["normal", "emergency"] as const)(
    "leaves a fitting request unchanged in %s mode and does not retain its objects",
    (mode) => {
      const messages = transcript(3);
      const policy = createLoopContextPolicy({});
      const result = fit(policy, messages, tokens(messages), mode);
      expect(result).toEqual({
        messages,
        elidedToolResultCount: 0,
        collapsedStepCount: 0,
      });
      expect(result.messages).not.toBe(messages);
      expect(fit(policy, structuredClone(messages), 20_000, mode)).toEqual(
        result,
      );
    },
  );

  it.each([
    ["en-US", "[older tool output omitted]"],
    ["zh-CN", "[较早的工具输出已省略]"],
    ["fr-FR", "[older tool output omitted]"],
  ])(
    "elides oldest results first, preserves the envelope and newest two groups in %s",
    (locale, marker) => {
      const messages = transcript(4);
      const before = structuredClone(messages);
      const result = fit(
        createLoopContextPolicy({ locale }),
        messages,
        tokens(messages) - 1,
      );
      expect(result.elidedToolResultCount).toBe(2);
      expect(result.collapsedStepCount).toBe(0);
      for (const index of [1, 3])
        expect(JSON.parse(String(result.messages[index]!.content))).toEqual({
          summary: `read page ${Math.floor(index / 2)}`,
          data: marker,
          staged: true,
          error: { code: "EMPTY" },
        });
      expect(result.messages.slice(-4)).toEqual(messages.slice(-4));
      expect(messages).toEqual(before);
    },
  );

  it("collapses oldest groups into one frozen digest while preserving newest continuation", () => {
    const messages = transcript(
      4,
      600,
      JSON.stringify({ query: "a".repeat(1_600) }),
    );
    const first = messages[0]!;
    messages[0] = {
      ...first,
      toolCalls: [
        ...first.toolCalls!,
        { id: "extra-call", name: "lookup", arguments: "{}" },
      ],
    };
    messages.splice(2, 0, {
      role: "tool",
      toolCallId: "extra-call",
      content: JSON.stringify({ summary: "s".repeat(200), data: null }),
    });
    messages[messages.length - 2] = {
      ...messages[messages.length - 2]!,
      providerContinuation: {
        protocol: "openai-chat-v1",
        model: "fixture",
        items: [{ type: "reasoning" }],
      },
    };
    const result = fit(createLoopContextPolicy({}), messages, 1_000);
    expect(result.collapsedStepCount).toBe(3);
    const digests = result.messages.filter(
      (message) => message.role === "system",
    );
    expect(digests).toHaveLength(1);
    const digest = String(digests[0]!.content);
    expect(digest.split("\n")).toHaveLength(5);
    expect(digest).toContain("read(");
    expect(digest).toContain("…) -> failed: EMPTY");
    expect(digest).toContain(`- lookup("{}") -> ok: ${"s".repeat(79)}…`);
    expect(digest).not.toMatch(/call-\d|extra-call|scratch|reasoning/);
    expect(result.messages.slice(-2)).toEqual(messages.slice(-2));
  });

  it("removes call identifiers, UUIDs and timestamps from digest previews and summaries", () => {
    const uuid = "aabbccdd-1111-2222-3333-123456789abc";
    const date = "2026-10-31T12:00:00.000Z";
    const messages = group(0, 10, JSON.stringify({ id: uuid, at: date }));
    messages[1] = {
      ...messages[1]!,
      content: JSON.stringify({ summary: `call-0 ${uuid} ${date}` }),
    };
    const result = fit(createLoopContextPolicy({}), messages, 1, "emergency");
    expect(result.collapsedStepCount).toBe(1);
    const digest = String(result.messages[0]!.content);
    expect(digest).not.toContain("call-0");
    expect(digest).not.toMatch(/[0-9a-f]{8}-[0-9a-f-]{27}|\d{4}-\d{2}-\d{2}T/);
  });

  it.each(["normal", "emergency"] as const)(
    "stops eliding at seventy percent and replays byte-identical prefixes in %s mode",
    (mode) => {
      const messages = transcript(5);
      const limit = tokens(messages) - 1;
      const policy = createLoopContextPolicy({});
      const first = fit(policy, messages, limit, mode);
      expect(tokens(first.messages)).toBeLessThanOrEqual(
        Math.floor(0.7 * limit),
      );
      expect(first.elidedToolResultCount).toBe(2);
      expect(first.collapsedStepCount).toBe(0);
      expect(first.messages.slice(4)).toEqual(messages.slice(4));
      const next = fit(
        policy,
        [...structuredClone(messages), { role: "user", content: "more" }],
        limit,
        mode,
      );
      expect(next.messages.slice(0, -1)).toEqual(first.messages);
      expect(next.elidedToolResultCount).toBe(first.elidedToolResultCount);
      expect(next.collapsedStepCount).toBe(first.collapsedStepCount);
    },
  );

  it.each(["normal", "emergency"] as const)(
    "stops collapsing at seventy percent in %s mode",
    (mode) => {
      const messages = transcript(
        4,
        10,
        JSON.stringify({ query: "q".repeat(800) }),
      );
      const limit = tokens(messages) - 1;
      const result = fit(createLoopContextPolicy({}), messages, limit, mode);
      expect(tokens(result.messages)).toBeLessThanOrEqual(
        Math.floor(0.7 * limit),
      );
      expect(result.collapsedStepCount).toBe(2);
      expect(
        result.messages.filter((message) => message.role === "assistant"),
      ).toEqual([messages[4], messages[6]]);
    },
  );

  it("keeps collapse events separate and monotonically replays them after hook rewrites", () => {
    const messages = transcript(
      4,
      10,
      JSON.stringify({ query: "q".repeat(800) }),
    );
    const policy = createLoopContextPolicy({});
    const first = fit(policy, messages, 1_600);
    expect(first.collapsedStepCount).toBeGreaterThan(0);
    const replay = fit(policy, structuredClone(messages), 20_000);
    expect(replay).toEqual(first);
    const nextMessages = [
      ...structuredClone(messages),
      ...group(4, 10, JSON.stringify({ query: "q".repeat(800) })),
    ];
    const second = fit(policy, nextMessages, 1_600);
    expect(
      second.messages.filter((message) => message.role === "system"),
    ).toHaveLength(2);
    expect(second.messages[0]).toEqual(first.messages[0]);
    expect(second.collapsedStepCount).toBeGreaterThan(first.collapsedStepCount);
    expect(fit(policy, group(9), 20_000).messages).toEqual(group(9));
  });

  it("keeps newest results and frozen prefixes when a provider reuses call IDs", () => {
    const messages = repeatedIds(transcript(4));
    const policy = createLoopContextPolicy({});
    const limit = tokens(messages) - 1;
    const first = fit(policy, messages, limit);
    expect(first.elidedToolResultCount).toBe(2);
    expect(first.messages.slice(-4)).toEqual(messages.slice(-4));
    const next = fit(policy, [...messages, ...repeatedIds(group(4))], limit);
    expect(next.messages.slice(0, first.messages.length)).toEqual(
      first.messages,
    );
    expect(next.messages.slice(-2)).toEqual(repeatedIds(group(4)));
    const largeArguments = repeatedIds(
      transcript(4, 10, JSON.stringify({ query: "q".repeat(800) })),
    );
    const collapsing = createLoopContextPolicy({});
    const collapsed = fit(collapsing, largeArguments, 1_600);
    const replay = fit(collapsing, structuredClone(largeArguments), 20_000);
    expect(replay).toEqual(collapsed);
    expect(replay.collapsedStepCount).toBeGreaterThan(0);
    expect(replay.messages.slice(-2)).toEqual(largeArguments.slice(-2));
  });

  it.each(["elision", "collapse"] as const)(
    "skips a missing or ambiguous %s when a hook filters reused call IDs",
    (stage) => {
      const firstGroup = group(
        0,
        stage === "elision" ? 5_000 : 10,
        stage === "collapse"
          ? JSON.stringify({ query: "q".repeat(5_000) })
          : "{}",
      );
      const messages = repeatedIds([
        ...firstGroup,
        ...group(1, 10),
        ...group(2, 10),
        ...group(3, 10),
      ]);
      const policy = createLoopContextPolicy({});
      const first = fit(policy, messages, 2_000);
      expect(first.elidedToolResultCount).toBeGreaterThan(0);
      expect(first.collapsedStepCount).toBe(stage === "collapse" ? 1 : 0);
      expect(first.messages.slice(-4)).toEqual(messages.slice(-4));

      const rewritten = structuredClone(messages.slice(2));
      const replay = fit(policy, rewritten, 20_000);
      expect(replay.collapsedStepCount).toBe(0);
      expect(replay.elidedToolResultCount).toBe(
        first.elidedToolResultCount - 1,
      );
      expect(replay.messages).toEqual(
        first.messages.slice(stage === "collapse" ? 1 : 2),
      );

      const ambiguous = structuredClone([...messages.slice(0, 2), ...messages]);
      const skipped = fit(policy, ambiguous, 20_000);
      expect(skipped.collapsedStepCount).toBe(0);
      expect(skipped.elidedToolResultCount).toBe(
        first.elidedToolResultCount - 1,
      );
      expect(skipped.messages.slice(0, 4)).toEqual(ambiguous.slice(0, 4));
    },
  );

  it.each(["name", "arguments"] as const)(
    "does not replay elision when a hook changes the call's %s",
    (field) => {
      const messages = transcript(4);
      const policy = createLoopContextPolicy({});
      expect(
        fit(policy, messages, tokens(messages) - 1).elidedToolResultCount,
      ).toBe(2);
      const rewritten = structuredClone(messages);
      rewritten[0] = {
        ...rewritten[0]!,
        toolCalls: rewritten[0]!.toolCalls!.map((call) => ({
          ...call,
          [field]: field === "name" ? "lookup" : '{"page":2}',
        })),
      };
      const replay = fit(policy, rewritten, 20_000);
      expect(replay.elidedToolResultCount).toBe(1);
      expect(replay.messages[1]).toEqual(rewritten[1]);
    },
  );

  it("silently skips a frozen event when a hook removed only part of its groups", () => {
    const messages = transcript(
      4,
      10,
      JSON.stringify({ query: "q".repeat(800) }),
    );
    const policy = createLoopContextPolicy({});
    fit(policy, messages, 1_200);
    const rewritten = messages.slice(2);
    const replay = fit(policy, rewritten, 20_000);
    expect(replay.collapsedStepCount).toBe(0);
    expect(
      replay.messages.filter((message) => message.role === "assistant"),
    ).toHaveLength(3);
  });

  it("leaves incomplete and reordered groups alone", () => {
    const complete = group(0);
    const reordered = [complete[1]!, complete[0]!];
    const second = group(1);
    const batch = {
      ...complete[0]!,
      toolCalls: [...complete[0]!.toolCalls!, ...second[0]!.toolCalls!],
    };
    const reorderedResults = [batch, second[1]!, complete[1]!];
    const incompleteBatch = [batch, complete[1]!];
    for (const malformed of [
      [complete[0]!],
      reordered,
      reorderedResults,
      incompleteBatch,
    ]) {
      const result = createLoopContextPolicy({}).fit(
        malformed,
        context(1, "emergency"),
      );
      expect(result).toEqual({
        messages: malformed,
        elidedToolResultCount: 0,
        collapsedStepCount: 0,
      });
    }
  });

  it("can collapse every group in emergency mode when needed to reach the target", () => {
    const messages = transcript(
      3,
      10,
      JSON.stringify({ query: "q".repeat(800) }),
    );
    const result = fit(
      createLoopContextPolicy({ locale: "zh-CN" }),
      messages,
      500,
      "emergency",
    );
    expect(result.collapsedStepCount).toBe(3);
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0]?.content).toContain(
      "本次运行较早的工具步骤，已压缩",
    );
  });

  it("is deterministic and never mutates input arrays, messages or nested content", () => {
    const messages = transcript(4);
    const before = structuredClone(messages);
    const first = fit(createLoopContextPolicy({}), messages, 1_000);
    const second = fit(
      createLoopContextPolicy({}),
      structuredClone(messages),
      1_000,
    );
    expect(first).toEqual(second);
    expect(messages).toEqual(before);
  });

  it("elides non-JSON and objects without data, and leaves non-string results alone", () => {
    const messages = transcript(6);
    messages[1] = { ...messages[1]!, content: "raw ".repeat(500) };
    messages[3] = {
      ...messages[3]!,
      content: JSON.stringify({ value: "v".repeat(2_000) }),
    };
    messages[5] = {
      ...messages[5]!,
      content: [{ type: "text", text: "parts" }],
    };
    const result = fit(createLoopContextPolicy({}), messages, 5_000);
    expect(result.messages[1]?.content).toBe("[older tool output omitted]");
    expect(result.messages[3]?.content).toBe("[older tool output omitted]");
    expect(result.messages[5]).toEqual(messages[5]);
    expect(JSON.parse(String(result.messages[7]?.content)).data).toBe(
      "[older tool output omitted]",
    );
    expect(result.messages.slice(-4)).toEqual(messages.slice(-4));
    expect(result.elidedToolResultCount).toBe(3);
    expect(result.collapsedStepCount).toBe(0);
  });
});
