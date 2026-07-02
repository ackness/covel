import { describe, expect, it, vi } from "vitest";
import { createEmitEventTool } from "../src/builtin/emit-event.js";
import { getEmittedEvents, getPendingProposals } from "../src/result.js";
import type { ToolExecutionContext } from "../src/types.js";

const ctx: ToolExecutionContext = {
  sessionId: "s1",
  turnId: "t1",
  pluginId: "narrator",
  runtimeId: "narrator",
};

interface FakeTopicEntry {
  readonly topic: string;
  readonly requires?: string;
}

function makeDirectory(entries: readonly FakeTopicEntry[]) {
  return {
    listTopics: vi.fn((_sessionId: string) =>
      entries.map((entry) => entry.topic),
    ),
    validate: vi.fn(
      (_sessionId: string, topic: string, data: Record<string, unknown>) => {
        const hit = entries.find((entry) => entry.topic === topic);
        if (!hit)
          return { ok: false as const, reason: `unknown topic "${topic}"` };
        if (hit.requires && !(hit.requires in data)) {
          return {
            ok: false as const,
            reason: `missing field ${hit.requires}`,
          };
        }
        return { ok: true as const };
      },
    ),
  };
}

describe("emit-event tool", () => {
  it("emits a valid event through the emitted-events channel", async () => {
    const tool = createEmitEventTool({
      directory: makeDirectory([{ topic: "scene.set" }]),
    });
    const result = await tool.execute(
      { topic: "scene.set", data: { location: "教室" } },
      ctx,
    );
    expect(getEmittedEvents(result)).toEqual([
      { topic: "scene.set", data: { location: "教室" } },
    ]);
  });

  it("returns a readable error listing known topics for an undeclared topic", async () => {
    const tool = createEmitEventTool({
      directory: makeDirectory([{ topic: "scene.set" }]),
    });
    const result = (await tool.execute(
      { topic: "quest.done", data: {} },
      ctx,
    )) as { _text: string };
    expect(getEmittedEvents(result)).toBeUndefined();
    expect(result._text).toContain('unknown topic "quest.done"');
    expect(result._text).toContain("scene.set");
  });

  it("returns the schema validation error verbatim so the LLM can retry", async () => {
    const tool = createEmitEventTool({
      directory: makeDirectory([{ topic: "scene.set", requires: "location" }]),
    });
    const result = (await tool.execute(
      { topic: "scene.set", data: {} },
      ctx,
    )) as { _text: string };
    expect(getEmittedEvents(result)).toBeUndefined();
    expect(result._text).toContain("missing field location");
  });

  it("never returns event.emit pending proposals (double-emission guard)", async () => {
    const tool = createEmitEventTool({
      directory: makeDirectory([{ topic: "scene.set" }]),
    });
    const result = await tool.execute({ topic: "scene.set", data: {} }, ctx);
    expect(getPendingProposals(result)).toHaveLength(0);
  });

  it("no-ops with a hint when the topic was already emitted this turn", async () => {
    const tool = createEmitEventTool({
      directory: makeDirectory([{ topic: "scene.set" }]),
    });
    const result = (await tool.execute(
      { topic: "scene.set", data: {} },
      { ...ctx, emittedEventTopics: ["scene.set"] },
    )) as { _text: string };
    expect(getEmittedEvents(result)).toBeUndefined();
    expect(result._text).toContain("already emitted");
  });
});
