import { afterEach, describe, expect, it, vi } from "vitest";
import { lateSystemMessagesAsUser } from "../src/adapters/common.js";
import { createOpenAiChatAdapter } from "../src/adapters/openai-chat.js";
import { createOpenAiResponsesAdapter } from "../src/adapters/openai-responses.js";
import type { TextMessage } from "../src/types.js";

const context = { profile: {} as never, preset: null, mode: "text" as const };

const messages: TextMessage[] = [
  { role: "system", content: "stable rules" },
  { role: "assistant", content: "earlier reply" },
  { role: "system", content: "this turn's data" },
  { role: "user", content: "what now?" },
  { role: "system", content: "post-history rule" },
];

afterEach(() => {
  vi.unstubAllGlobals();
});

function sentBody(): Record<string, unknown> {
  const init = vi.mocked(fetch).mock.calls[0]?.[1] as RequestInit | undefined;
  return JSON.parse(String(init?.body)) as Record<string, unknown>;
}

describe("lateSystemMessagesAsUser", () => {
  it("keeps leading system messages and wraps the later ones as user messages in place", () => {
    const out = lateSystemMessagesAsUser(messages);
    expect(out.map((m) => m.role)).toEqual([
      "system",
      "assistant",
      "user",
      "user",
      "user",
    ]);
    expect(out[0]).toBe(messages[0]);
    expect(out[2]!.content).toBe(
      "<system-instruction>\nthis turn's data\n</system-instruction>",
    );
  });

  it("wraps part arrays without dropping a part", () => {
    const image = { type: "image", image: "data:image/png;base64,AAAA" };
    const out = lateSystemMessagesAsUser([
      { role: "user", content: "hi" },
      { role: "developer", content: [{ type: "text", text: "note" }, image] },
    ] as TextMessage[]);
    expect(out[1]!.role).toBe("user");
    expect(out[1]!.content).toEqual([
      { type: "text", text: "<system-instruction>\n" },
      { type: "text", text: "note" },
      image,
      { type: "text", text: "\n</system-instruction>" },
    ]);
  });

  it("leaves a request of system messages only unchanged", () => {
    const only: TextMessage[] = [
      { role: "system", content: "a" },
      { role: "system", content: "b" },
    ];
    expect(lateSystemMessagesAsUser(only)).toEqual(only);
  });
});

describe("turn context ahead of the cache on the OpenAI wires", () => {
  it("Chat sends the same bytes up to the history end whatever the turn context says", async () => {
    const send = async (turnContext: string) => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({
          ok: true,
          status: 200,
          text: async () =>
            JSON.stringify({
              choices: [{ message: { content: "ok" }, finish_reason: "stop" }],
              usage: { prompt_tokens: 1, completion_tokens: 1 },
            }),
        }),
      );
      await createOpenAiChatAdapter().generateText(
        { baseUrl: "https://relay.example.com/v1" },
        {
          model: "m",
          messages: [
            { role: "system", content: "stable rules" },
            { role: "assistant", content: "history" },
            { role: "system", content: turnContext },
            { role: "user", content: "go" },
          ],
        },
        context,
      );
      return sentBody().messages as Array<{ role: string; content: string }>;
    };
    const first = await send("turn 1 data");
    const second = await send("turn 2 data");
    expect(first.map((m) => m.role)).toEqual([
      "system",
      "assistant",
      "user",
      "user",
    ]);
    expect(first.slice(0, 2)).toEqual(second.slice(0, 2));
    expect(first[2]!.content).not.toBe(second[2]!.content);
  });

  it("Responses sends later system messages as user input items", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({
            status: "completed",
            output: [
              {
                type: "message",
                content: [{ type: "output_text", text: "ok" }],
              },
            ],
            usage: { input_tokens: 1, output_tokens: 1 },
          }),
      }),
    );
    await createOpenAiResponsesAdapter().generateText(
      { baseUrl: "https://relay.example.com/v1" },
      { model: "m", messages },
      context,
    );
    const input = sentBody().input as Array<{ role: string }>;
    expect(input.map((item) => item.role)).toEqual([
      "system",
      "assistant",
      "user",
      "user",
      "user",
    ]);
  });
});
