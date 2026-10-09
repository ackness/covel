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
    expect(invoked).toHaveLength(3);
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
