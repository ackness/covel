// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { createOpenAiChatAdapter } from "../src/adapters/openai-chat.js";
import { createOpenAiResponsesAdapter } from "../src/adapters/openai-responses.js";
import {
  createThinkTagSplitter,
  splitThinkTags,
  type ThinkPart,
} from "../src/adapters/think-tags.js";
import type { TextMessage } from "../src/types.js";

/** Feed `text` in pieces of `size` characters and merge the parts. */
function streamed(text: string, size: number): ThinkPart[] {
  const splitter = createThinkTagSplitter();
  const parts: ThinkPart[] = [];
  for (let at = 0; at < text.length; at += size)
    parts.push(...splitter.push(text.slice(at, at + size)));
  parts.push(...splitter.flush());
  return parts.reduce<ThinkPart[]>((merged, part) => {
    const last = merged.at(-1);
    if (last?.type === part.type)
      merged[merged.length - 1] = { ...last, text: last.text + part.text };
    else merged.push(part);
    return merged;
  }, []);
}

describe("think tag splitting", () => {
  const reply = "<think>\nweigh the options\n</think>\n\nThe gate opens.";

  it("moves a leading block to reasoning and keeps the reply", () => {
    expect(splitThinkTags(reply)).toEqual({
      text: "The gate opens.",
      reasoning: "weigh the options\n",
      sawThink: true,
    });
  });

  it.each([1, 2, 3, 7])(
    "gives the same parts when tags are cut across %i-character pieces",
    (size) => {
      expect(streamed(reply, size)).toEqual([
        { type: "reasoning", text: "weigh the options\n" },
        { type: "text", text: "The gate opens." },
      ]);
    },
  );

  it("treats a block the reply was cut inside as reasoning to the end", () => {
    expect(splitThinkTags("<think>still weighing")).toMatchObject({
      text: "",
      reasoning: "still weighing",
    });
  });

  it("splits every block and keeps the text between them", () => {
    expect(
      splitThinkTags("A<think>one</think>B<think>two</think>C"),
    ).toMatchObject({ text: "A\nB\nC", reasoning: "one\ntwo" });
  });

  it("leaves a reply without blocks untouched, including a lone `<`", () => {
    for (const text of ["a < b and <thin ice>", "ends with <thi"]) {
      expect(splitThinkTags(text)).toEqual({
        text,
        reasoning: "",
        sawThink: false,
      });
      expect(streamed(text, 1)).toEqual([{ type: "text", text }]);
    }
  });
});

describe("openai-chat inline <think> reasoning", () => {
  const config = { baseUrl: "https://fixture.invalid" };
  const model = "fixture-thinker";
  const messages: TextMessage[] = [{ role: "user", content: "fixture" }];
  afterEach(() => vi.unstubAllGlobals());

  function respond(body: Record<string, unknown>) {
    const fetcher = vi.fn().mockImplementation(async () => Response.json(body));
    vi.stubGlobal("fetch", fetcher);
    return fetcher;
  }

  it("streams the reasoning apart from the reply text", async () => {
    const chunks = ["<thi", "nk>\nplan", " it</th", "ink>\n\nThe ", "gate."];
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(
        async () =>
          new Response(
            [
              ...chunks.map((content) => ({
                choices: [{ delta: { content } }],
              })),
              { choices: [{ delta: {}, finish_reason: "stop" }] },
            ]
              .map((event) => `data: ${JSON.stringify(event)}\n\n`)
              .join(""),
            { headers: { "content-type": "text/event-stream" } },
          ),
      ),
    );
    const events = await Array.fromAsync(
      createOpenAiChatAdapter().streamText(config, { model, messages }),
    );
    const text = events
      .filter((event) => event.type === "text-delta")
      .map((event) => event.textDelta)
      .join("");
    const reasoning = events
      .filter((event) => event.type === "reasoning-delta")
      .map((event) => event.reasoningDelta)
      .join("");
    expect(text).toBe("The gate.");
    expect(reasoning).toBe("plan it");
    const done = events.find((event) => event.type === "done")!;
    expect(done.reasoningContent).toBe("plan it");
    expect(done.providerContinuation?.items).toEqual([
      { type: "reasoning", field: "think" },
    ]);
  });

  it("splits a whole reply and does not send the reasoning back", async () => {
    respond({
      choices: [
        {
          message: { content: "<think>plan it</think>\n\nThe gate." },
          finish_reason: "stop",
        },
      ],
    });
    const adapter = createOpenAiChatAdapter();
    const first = await adapter.generateText(config, { model, messages });
    expect(first).toMatchObject({
      text: "The gate.",
      reasoningContent: "plan it",
    });

    const fetcher = respond({ choices: [{ message: { content: "ok" } }] });
    await adapter.generateText(config, {
      model,
      messages: [
        ...messages,
        {
          role: "assistant",
          content: first.text,
          reasoningContent: first.reasoningContent,
          providerContinuation: first.providerContinuation,
        },
        { role: "user", content: "next" },
      ],
    });
    const sent = JSON.parse(String(fetcher.mock.calls[0]![1].body)).messages;
    expect(sent[1]).toEqual({ role: "assistant", content: "The gate." });
  });

  it("splits inline reasoning out of a Responses stream", async () => {
    const events = [
      ...["<think>plan", " it</think>", "\n\nThe gate."].map((delta) => ({
        type: "response.output_text.delta",
        delta,
      })),
      { type: "response.completed", response: { status: "completed" } },
    ];
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockImplementation(
          async () =>
            new Response(
              events
                .map((event) => `data: ${JSON.stringify(event)}\n\n`)
                .join(""),
              { headers: { "content-type": "text/event-stream" } },
            ),
        ),
    );
    const out = await Array.fromAsync(
      createOpenAiResponsesAdapter().streamText(config, { model, messages }),
    );
    expect(
      out
        .filter((event) => event.type === "text-delta")
        .map((event) => event.textDelta)
        .join(""),
    ).toBe("The gate.");
    expect(out.find((event) => event.type === "done")?.reasoningContent).toBe(
      "plan it",
    );
  });

  it("parses a JSON object written after a <think> block", async () => {
    respond({
      choices: [
        {
          message: { content: '<think>check the schema</think>{"ok":true}' },
          finish_reason: "stop",
        },
      ],
    });
    const result = await createOpenAiChatAdapter().generateObject(config, {
      model,
      messages,
      schema: z.object({ ok: z.boolean() }),
    });
    expect(result.object).toEqual({ ok: true });
    expect(result.reasoningContent).toBe("check the schema");
  });
});
