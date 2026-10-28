import { afterEach, describe, expect, it } from "vitest";
import { getTextWire, type TextWire } from "@covel/ai-provider";
import { registerNamespaced } from "../../src/routes/api/bootstrap/plugin-wires.js";

const disposers: Array<() => void> = [];
afterEach(() => {
  for (const dispose of disposers.splice(0)) dispose();
});

const wire: TextWire = {
  id: "converse",
  label: "Acme Converse",
  async generateText() {
    return {
      text: "ok",
      finishReason: "stop",
      usage: { inputTokens: 1, outputTokens: 1 },
    };
  },
  async *streamText() {
    yield { type: "text-delta", textDelta: "ok" };
    yield {
      type: "done",
      finishReason: "stop",
      usage: { inputTokens: 1, outputTokens: 1 },
    };
  },
  listModels: async () => ["acme-1"],
};

describe("text wires of a plugin entry", () => {
  it("registers under the plugin's namespace and runs every call through the plugin scope", async () => {
    const invoked: string[] = [];
    registerNamespaced(
      "acme",
      { text: [wire] },
      (dispose) => disposers.push(dispose),
      async (fn) => {
        invoked.push("call");
        return fn();
      },
    );
    const registered = getTextWire("acme/converse")!;
    expect(registered.label).toBe("Acme Converse");

    await registered.generateText({}, { model: "m", messages: [] });
    const events = [];
    for await (const event of registered.streamText(
      {},
      { model: "m", messages: [] },
    ))
      events.push(event.type);
    expect(events).toEqual(["text-delta", "done"]);
    expect(await registered.listModels!({})).toEqual(["acme-1"]);
    // generateText, the stream's start and each of its three steps (two
    // events and the end), listModels: the stream body runs in the step
    // that pulls it, so each step goes through the scope.
    expect(invoked).toHaveLength(6);
  });

  it("never hands plugin code the local model relay", async () => {
    const seen: unknown[] = [];
    registerNamespaced(
      "acme",
      {
        text: [
          {
            ...wire,
            id: "peek",
            async generateText(config) {
              seen.push(config);
              return wire.generateText(config, { model: "m", messages: [] });
            },
          },
        ],
      },
      (dispose) => disposers.push(dispose),
    );
    const relay = { fetch: async () => new Response() };
    await getTextWire("acme/peek")!.generateText(
      {
        baseUrl: "http://127.0.0.1:3425/v1",
        apiKey: "k",
        relay,
        relayable: true,
      },
      { model: "m", messages: [] },
    );
    expect(seen).toEqual([
      { baseUrl: "http://127.0.0.1:3425/v1", apiKey: "k" },
    ]);
  });

  it.each([
    [{ text: {} }, /text wires must be an array/],
    [{ text: [{ id: "x", generateText() {} }] }, /streamText: function/],
    [{ text: [{ id: "", generateText() {}, streamText() {} }] }, /id: string/],
  ])("rejects a malformed text wire %#", (mod, message) => {
    expect(() => registerNamespaced("acme", mod as never)).toThrow(message);
  });

  it("names the wire that is already registered", () => {
    registerNamespaced("acme", { text: [wire] }, (dispose) =>
      disposers.push(dispose),
    );
    expect(() => registerNamespaced("acme", { text: [wire] })).toThrow(
      /wire "acme\/converse" is already registered/,
    );
  });
});
