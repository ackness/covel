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

const RELAY = "https://relay.example.com/v1";

function stubReply(payload: Record<string, unknown>): void {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => JSON.stringify(payload),
    }),
  );
}

const chatReply = {
  choices: [{ message: { content: "ok" }, finish_reason: "stop" }],
  usage: { prompt_tokens: 1, completion_tokens: 1 },
};
const responsesReply = {
  status: "completed",
  output: [{ type: "message", content: [{ type: "output_text", text: "ok" }] }],
  usage: { input_tokens: 1, output_tokens: 1 },
};

async function sendChat(
  turnContext: string,
  lateSystemAsUser?: boolean,
): Promise<Array<{ role: string; content: string }>> {
  stubReply(chatReply);
  await createOpenAiChatAdapter().generateText(
    { baseUrl: RELAY },
    {
      model: "m",
      messages: [
        { role: "system", content: "stable rules" },
        { role: "assistant", content: "history" },
        { role: "system", content: turnContext },
        { role: "user", content: "go" },
      ],
      ...(lateSystemAsUser === undefined
        ? {}
        : { providerRequestMetadata: { lateSystemAsUser } }),
    },
    context,
  );
  return sentBody().messages as Array<{ role: string; content: string }>;
}

describe("lateSystemAsUser option on the OpenAI wires", () => {
  it("leaves every role untouched by default and when off", async () => {
    for (const option of [undefined, false]) {
      const body = await sendChat("turn data", option);
      expect(body.map((m) => m.role)).toEqual([
        "system",
        "assistant",
        "system",
        "user",
      ]);
    }
    stubReply(responsesReply);
    await createOpenAiResponsesAdapter().generateText(
      { baseUrl: RELAY },
      { model: "m", messages },
      context,
    );
    expect(
      (sentBody().input as Array<{ role: string }>).map((i) => i.role),
    ).toEqual(["system", "assistant", "system", "user", "system"]);
  });

  it("Chat with the option keeps the bytes up to the history end whatever the turn context says", async () => {
    const first = await sendChat("turn 1 data", true);
    const second = await sendChat("turn 2 data", true);
    expect(first.map((m) => m.role)).toEqual([
      "system",
      "assistant",
      "user",
      "user",
    ]);
    expect(first.slice(0, 2)).toEqual(second.slice(0, 2));
    expect(first[2]!.content).not.toBe(second[2]!.content);
  });

  it("Responses with the option sends later system messages as user input items", async () => {
    stubReply(responsesReply);
    await createOpenAiResponsesAdapter().generateText(
      { baseUrl: RELAY },
      {
        model: "m",
        messages,
        providerRequestMetadata: { lateSystemAsUser: true },
      },
      context,
    );
    const body = sentBody();
    expect((body.input as Array<{ role: string }>).map((i) => i.role)).toEqual([
      "system",
      "assistant",
      "user",
      "user",
      "user",
    ]);
    expect(body).not.toHaveProperty("lateSystemAsUser");
  });
});
