import { describe, expect, it, vi } from "vitest";
import { createGoogleGenerativeAiAdapter } from "../src/adapters/google-generative-ai.js";
import { googleMessages } from "../src/adapters/google-messages.js";
import type { TextMessage } from "../src/types.js";

// Synthetic fixtures. The AI SDK's Google provider
// (packages/google/src/convert-to-google-messages.ts) rejects a system message
// after the conversation starts, so the in-place form is Covel's own. It was
// not verified against Google's endpoint.
const config = { baseUrl: "https://generativelanguage.googleapis.com/v1beta" };
const model = "gemini-2.5-flash";
type Content = { role: string; parts: Record<string, unknown>[] };
const convert = (messages: TextMessage[], lateSystemInPlace?: boolean) =>
  googleMessages(messages, config, model, lateSystemInPlace) as {
    contents: Content[];
    systemInstruction?: { parts: { text: string }[] };
  };
const instruction = (text: string) => ({
  text: `<system-instruction>\n${text}\n</system-instruction>`,
});

const stable: TextMessage = { role: "system", content: "Stable rules" };
const history: TextMessage[] = [
  { role: "user", content: "I open the door." },
  { role: "assistant", content: "It creaks." },
];
const call: TextMessage = {
  role: "assistant",
  content: "",
  toolCalls: [{ id: "c1", name: "roll", arguments: '{"sides":20}' }],
};
const result: TextMessage = {
  role: "tool",
  toolCallId: "c1",
  content: '{"value":17}',
};
const functionCall = { functionCall: { name: "roll", args: { sides: 20 } } };
const functionResponse = {
  functionResponse: { name: "roll", response: { value: 17 } },
};

function expectAlternating(contents: Content[]) {
  for (const [index, content] of contents.entries()) {
    expect(content.parts.length).toBeGreaterThan(0);
    if (index > 0) expect(content.role).not.toBe(contents[index - 1]!.role);
  }
}

describe("Gemini system messages after the conversation starts", () => {
  it("keeps only the leading system messages in systemInstruction", () => {
    const out = convert([
      stable,
      { role: "developer", content: "More stable rules" },
      ...history,
      { role: "system", content: "Turn 3 context" },
      { role: "user", content: "I look inside." },
    ]);
    expect(out.systemInstruction).toEqual({
      parts: [{ text: "Stable rules" }, { text: "More stable rules" }],
    });
    expect(out.contents).toEqual([
      { role: "user", parts: [{ text: "I open the door." }] },
      { role: "model", parts: [{ text: "It creaks." }] },
      {
        role: "user",
        parts: [instruction("Turn 3 context"), { text: "I look inside." }],
      },
    ]);
  });

  it("leaves the request unchanged up to the end of the history when only the turn message differs", () => {
    const turn = (context: string) =>
      JSON.stringify(
        convert([
          stable,
          ...history,
          call,
          result,
          { role: "assistant", content: "A 17." },
          { role: "system", content: context },
          { role: "user", content: "I look inside." },
        ]),
      );
    const first = turn("Turn 3: the lamp is lit");
    const second = turn("Turn 4: the lamp is out");
    const shared = [...first].findIndex((char, i) => char !== second[i]);
    const prefix = first.slice(0, shared);
    // `systemInstruction` serializes after `contents`; the wire order is the
    // provider's. What matters is that it and every history turn are equal.
    expect(
      prefix.endsWith(
        '{"role":"model","parts":[{"text":"A 17."}]},' +
          '{"role":"user","parts":[{"text":"<system-instruction>\\nTurn ',
      ),
    ).toBe(true);
    expect(JSON.parse(first).systemInstruction).toEqual(
      JSON.parse(second).systemInstruction,
    );
    expect(first).not.toBe(second);
  });

  it("extends the previous turn's request when the next turn is appended", () => {
    const turnOne = convert([
      stable,
      ...history,
      { role: "system", content: "Turn 2 context" },
      { role: "user", content: "I look inside." },
    ]);
    const turnTwo = convert([
      stable,
      ...history,
      { role: "user", content: "I look inside." },
      { role: "assistant", content: "Dust." },
      { role: "system", content: "Turn 3 context" },
      { role: "user", content: "I leave." },
    ]);
    expect(turnTwo.contents.slice(0, 2)).toEqual(turnOne.contents.slice(0, 2));
    expect(turnTwo.systemInstruction).toEqual(turnOne.systemInstruction);
  });

  it("merges same-role neighbours so turns alternate", () => {
    const out = convert([
      stable,
      { role: "user", content: "One" },
      { role: "user", content: "Two" },
      { role: "system", content: "Rule A" },
      { role: "system", content: "Rule B" },
      { role: "assistant", content: "Three" },
      { role: "assistant", content: "Four" },
      { role: "system", content: "Rule C" },
    ]);
    expect(out.contents).toEqual([
      {
        role: "user",
        parts: [
          { text: "One" },
          { text: "Two" },
          instruction("Rule A"),
          instruction("Rule B"),
        ],
      },
      { role: "model", parts: [{ text: "Three" }, { text: "Four" }] },
      { role: "user", parts: [instruction("Rule C")] },
    ]);
    expectAlternating(out.contents);
  });

  it("puts an instruction after the function responses of a tool loop, in their turn", () => {
    const out = convert([
      stable,
      { role: "user", content: "Roll." },
      call,
      result,
      { role: "system", content: "Retry rule" },
    ]);
    expect(out.contents).toEqual([
      { role: "user", parts: [{ text: "Roll." }] },
      { role: "model", parts: [functionCall] },
      { role: "user", parts: [functionResponse, instruction("Retry rule")] },
    ]);
    expectAlternating(out.contents);
  });

  it("never separates a function call from its responses", () => {
    const out = convert([
      stable,
      { role: "user", content: "Roll." },
      call,
      { role: "system", content: "Between" },
      result,
      { role: "user", content: "And then?" },
    ]);
    expect(out.contents).toEqual([
      { role: "user", parts: [{ text: "Roll." }] },
      { role: "model", parts: [functionCall] },
      {
        role: "user",
        parts: [
          functionResponse,
          instruction("Between"),
          { text: "And then?" },
        ],
      },
    ]);
  });

  it("keeps a model turn that calls functions apart from a following model turn", () => {
    const out = convert([{ role: "user", content: "Roll." }, call, call]);
    expect(out.contents.map((content) => content.role)).toEqual([
      "user",
      "model",
      "model",
    ]);
  });

  it("sends a system-only request and an empty late instruction as before", () => {
    expect(convert([stable])).toEqual({
      contents: [],
      systemInstruction: { parts: [{ text: "Stable rules" }] },
    });
    expect(
      convert([...history, { role: "system", content: "" }]).contents,
    ).toHaveLength(2);
  });

  it("sends the earlier shape when the slot turns the option off", async () => {
    const messages: TextMessage[] = [
      stable,
      { role: "user", content: "One" },
      { role: "user", content: "Two" },
      { role: "system", content: "Turn 3 context" },
    ];
    expect(convert(messages, false)).toEqual({
      contents: [
        { role: "user", parts: [{ text: "One" }] },
        { role: "user", parts: [{ text: "Two" }] },
      ],
      systemInstruction: {
        parts: [{ text: "Stable rules" }, { text: "Turn 3 context" }],
      },
    });

    // Through the adapter: in place unless the slot says false, and the
    // option itself never reaches the provider.
    const bodies: Record<string, unknown>[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(async (_url, init: RequestInit) => {
        bodies.push(JSON.parse(String(init.body)));
        return new Response(
          JSON.stringify({
            candidates: [
              {
                content: { role: "model", parts: [{ text: "ok" }] },
                finishReason: "STOP",
              },
            ],
          }),
          { headers: { "content-type": "application/json" } },
        );
      }),
    );
    const adapter = createGoogleGenerativeAiAdapter();
    for (const lateSystemAsUser of [undefined, true, false]) {
      await adapter.generateText(
        { ...config, apiKey: "synthetic-test-key" },
        {
          model,
          messages,
          ...(lateSystemAsUser === undefined
            ? {}
            : { providerRequestMetadata: { lateSystemAsUser } }),
        },
      );
    }
    vi.unstubAllGlobals();
    const [unset, on, off] = bodies;
    expect(unset).toEqual(on);
    expect(unset).toMatchObject(convert(messages));
    expect(off).toMatchObject(convert(messages, false));
    for (const body of bodies)
      expect(JSON.stringify(body)).not.toContain("lateSystemAsUser");
  });

  it("rejects a late system message that is not text", () => {
    expect(() =>
      convert([
        ...history,
        {
          role: "system",
          content: [{ type: "image", image: "data:image/png;base64,YWJjZA==" }],
        },
      ]),
    ).toThrow("Gemini system instructions require text");
  });
});
