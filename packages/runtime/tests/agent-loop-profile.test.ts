/**
 * The agent loop reads its behaviour from a resolved loop profile: the
 * preset of `outputKind` (or the one the author names) with the author's
 * overrides merged. These cases pin the resolver, each profile field in the
 * loop core, the deadline reserve and its settlement.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { tool } from "@covel/tools";
import type { LLMAdapter, LLMResponse, RuntimeManifest } from "@covel/shared";
import {
  LOOP_PRESETS,
  resolveLoopProfile,
} from "../src/agent-loop/loop-profile.js";
import { settleAgentLoop } from "../src/agent-loop/settle-agent-loop.js";
import { stopOf } from "../src/agent-loop/stop-reason.js";
import { trackSteeringReaders } from "../src/turn-executor/turn-control.js";
import type { AgentToolLoopCompleted } from "../src/agent-loop/turn-agent-tool-loop.js";
import {
  input,
  makeExecutor,
  manifest,
  markTool,
  prose,
  queuedLLM,
  runLoop,
  scriptedLLM,
  toolCall,
} from "./_helpers/agent-loop-fixture.js";

const FINAL_ANSWER_TEXT = "Give your final answer now";
const WRITE_STORY_TEXT = "Write this turn's narrative now";

function story(overrides?: Partial<RuntimeManifest>): RuntimeManifest {
  return manifest({
    name: "plug/story",
    outputKind: "story",
    tools: {},
    ...overrides,
  });
}

function systemTexts(params: { readonly messages: readonly unknown[] }) {
  return params.messages
    .map((message) => message as { role: string; content: unknown })
    .filter((message) => message.role === "system")
    .map((message) => String(message.content));
}

async function thrownBy(run: Promise<unknown>): Promise<unknown> {
  try {
    await run;
  } catch (error) {
    return error;
  }
  throw new Error("expected the loop to throw");
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("resolveLoopProfile", () => {
  it("gives a story the story preset and every other runtime the system preset", () => {
    expect(resolveLoopProfile({ outputKind: "story" })).toEqual({
      preset: "story",
      ...LOOP_PRESETS.story,
      answerPrompt: "story",
    });
    for (const outputKind of ["system", undefined] as const)
      expect(resolveLoopProfile({ outputKind })).toEqual({
        preset: "system",
        ...LOOP_PRESETS.system,
        answerPrompt: "answer",
      });
  });

  it("uses the preset the author names", () => {
    expect(
      resolveLoopProfile({
        outputKind: "system",
        loopProfile: { preset: "actor" },
      }),
    ).toEqual({
      preset: "actor",
      ...LOOP_PRESETS.actor,
      answerPrompt: "answer",
    });
  });

  it("merges overrides field by field over the preset", () => {
    expect(
      resolveLoopProfile({
        outputKind: "story",
        loopProfile: {
          stream: false,
          finalizer: { deadlineReserveMs: 5_000 },
        },
      }),
    ).toEqual({
      preset: "story",
      stream: false,
      steering: true,
      truncation: "accept",
      fallback: "answer-without-tools",
      finalizer: { maxSteps: true, deadlineReserveMs: 5_000 },
      answerPrompt: "story",
    });
    expect(
      resolveLoopProfile({
        outputKind: "system",
        loopProfile: { preset: "actor", fallback: "fail" },
      }),
    ).toMatchObject({ preset: "actor", fallback: "fail", stream: false });
  });

  it("derives answerPrompt from outputKind, whatever the preset", () => {
    expect(
      resolveLoopProfile({
        outputKind: "story",
        loopProfile: { preset: "actor" },
      }).answerPrompt,
    ).toBe("story");
    expect(
      resolveLoopProfile({
        outputKind: "system",
        loopProfile: { preset: "actor" },
      }).answerPrompt,
    ).toBe("answer");
  });

  it("keeps the preset table frozen", () => {
    expect(Object.isFrozen(LOOP_PRESETS)).toBe(true);
    expect(Object.isFrozen(LOOP_PRESETS.story)).toBe(true);
    expect(Object.isFrozen(LOOP_PRESETS.story.finalizer)).toBe(true);
  });
});

describe("the loop core under a profile", () => {
  it("(i) a story with stream: false forwards no text and keeps its content", async () => {
    const onDelta = vi.fn();
    const llm: LLMAdapter = {
      generate: async () => prose("fallback"),
      stream: async function* () {
        yield { type: "text-delta" as const, textDelta: "Once " };
        yield { type: "text-delta" as const, textDelta: "upon" };
        yield {
          type: "done" as const,
          finishReason: "stop" as const,
          usage: { inputTokens: 1, outputTokens: 1 },
        };
      },
    };
    const result = await runLoop({
      llm,
      // g3: a story that stops streaming also rejects truncated text.
      manifest: story({ loopProfile: { stream: false, truncation: "reject" } }),
      deps: { toolExecutor: undefined, onDelta },
    });
    expect(onDelta).not.toHaveBeenCalled();
    expect(result.streamDeltaCount).toBe(0);
    expect(result.finalContent).toBe("Once upon");
    expect(result.stop).toEqual({ reason: "completed" });
  });

  it("(ii) a story with steering: false leaves the queue undrained", async () => {
    const drainSteering = vi.fn(() => ["turn left"]);
    const llm = queuedLLM([prose("The road forks.")]);
    const result = await runLoop({
      llm,
      manifest: story({ loopProfile: { steering: false } }),
      deps: { toolExecutor: undefined, turnControl: { drainSteering } },
    });
    expect(drainSteering).not.toHaveBeenCalled();
    expect(llm.requests).toHaveLength(1);
    expect(result.finalContent).toBe("The road forks.");
  });

  it("(iii) a story with fallback: fail throws loop-detected on the second detection", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    let i = 0;
    const error = await thrownBy(
      runLoop({
        llm: scriptedLLM((params) =>
          params.tools
            ? toolCall("mark", { note: "same" }, `tc-${i++}`)
            : prose("never"),
        ),
        manifest: story({
          tools: { plugin: ["mark"] },
          loopProfile: { fallback: "fail" },
        }),
        maxSteps: 20,
      }),
    );
    expect(String(error)).toContain("tool-loop detected");
    expect(stopOf(error)).toEqual({ reason: "loop-detected" });
  });

  it("(iv) an actor repeating a tool call continues without tools and gives its answer", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    let i = 0;
    const llm = scriptedLLM((params) =>
      params.tools
        ? toolCall("mark", { note: "same" }, `tc-${i++}`)
        : prose("The guard lets you pass."),
    );
    const result = await runLoop({
      llm,
      manifest: manifest({ loopProfile: { preset: "actor" } }),
      maxSteps: 20,
    });
    expect(result.stop).toEqual({ reason: "completed" });
    expect(result.finalContent).toBe("The guard lets you pass.");
    const last = llm.requests.at(-1)!;
    expect(last.tools).toBeUndefined();
    const texts = systemTexts(last);
    expect(texts.some((text) => text.includes(FINAL_ANSWER_TEXT))).toBe(true);
    expect(texts.some((text) => text.includes(WRITE_STORY_TEXT))).toBe(false);
  });

  it("(v) finalizer.maxSteps: false fails the step limit even when prose could answer", async () => {
    let n = 0;
    const llm = scriptedLLM((params) =>
      params.tools
        ? toolCall("mark", { note: `n${n}` }, `tc-${n++}`, "scratch")
        : prose("never"),
    );
    const result = await runLoop({
      llm,
      maxSteps: 2,
      manifest: manifest({ loopProfile: { finalizer: { maxSteps: false } } }),
    });
    expect(result.stop).toEqual({ reason: "max-steps" });
    // Two steps, no finalizer request.
    expect(llm.requests).toHaveLength(2);
    const settled = settleAgentLoop({
      manifest: manifest(),
      input,
      runId: "run",
      startTime: Date.now(),
      toolLoop: result,
    });
    expect(settled.kind).toBe("failed");
  });

  it("(vii) truncation: reject on a story fails a reply cut at the output limit", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const cut: LLMResponse = {
      ...prose("The fog rolls"),
      finishReason: "length",
    };
    const kept = await runLoop({
      llm: queuedLLM([cut]),
      manifest: story(),
      deps: { toolExecutor: undefined },
    });
    expect(kept.finalContent).toBe("The fog rolls");
    const error = await thrownBy(
      runLoop({
        llm: queuedLLM([cut]),
        manifest: story({ loopProfile: { truncation: "reject" } }),
        deps: { toolExecutor: undefined },
      }),
    );
    expect(String(error)).toContain("output limit");
  });
});

describe("the deadline reserve (vi)", () => {
  /** A virtual clock: each tool step costs `stepMs`, the finalizer `finalMs`. */
  function clockedLLM(opts: {
    readonly stepMs: number;
    readonly finalMs: number;
    readonly step: (n: number) => LLMResponse;
  }) {
    let now = 1_000_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    let n = 0;
    const llm = scriptedLLM((params) => {
      if (params.tools) {
        now += opts.stepMs;
        return opts.step(n++);
      }
      now += opts.finalMs;
      return prose("The answer, written in time.");
    });
    return llm;
  }

  it("stops stepping inside the reserve and lets the finalizer answer", async () => {
    // 20 s limit, 4 s per step: after four steps 4 s are left, inside the
    // 5 s reserve and above the finalizer's minimum.
    const llm = clockedLLM({
      stepMs: 4_000,
      finalMs: 500,
      step: (n) => toolCall("mark", { note: `n${n}` }, `tc-${n}`, "scratch"),
    });
    const result = await runLoop({
      llm,
      maxSteps: 20,
      timeoutMs: 20_000,
      manifest: manifest({
        loopProfile: { finalizer: { deadlineReserveMs: 5_000 } },
      }),
    });
    expect(result.stop).toEqual({ reason: "deadline", finalizer: true });
    expect(result.finalContent).toBe("The answer, written in time.");
    expect(llm.requests.filter((r) => r.tools)).toHaveLength(4);
    expect(llm.requests.at(-1)!.tools).toBeUndefined();
    const settled = settleAgentLoop({
      manifest: manifest(),
      input,
      runId: "run",
      startTime: Date.now(),
      toolLoop: result,
    });
    expect(settled.kind).toBe("success");
    expect(settled.result.stop).toEqual({
      reason: "deadline",
      finalizer: true,
    });
  });

  it("hands a story's finalizer the interjection queued during the last step", async () => {
    // The player interjects during the fourth step. The reserve then stops
    // the loop before the next pre-step drain, so the finalizer must merge
    // the queued message itself.
    const interjection = "Wait, I draw my sword first.";
    let toolSteps = 0;
    const llm = clockedLLM({
      stepMs: 4_000,
      finalMs: 500,
      step: (n) => {
        toolSteps = n + 1;
        return toolCall("mark", { note: `n${n}` }, `tc-${n}`, "scratch");
      },
    });
    let delivered = false;
    const drainSteering = vi.fn(() => {
      if (toolSteps < 4 || delivered) return [];
      delivered = true;
      return [interjection];
    });
    const result = await runLoop({
      llm,
      maxSteps: 20,
      timeoutMs: 20_000,
      manifest: story({
        tools: { plugin: ["mark"] },
        loopProfile: { finalizer: { deadlineReserveMs: 5_000 } },
      }),
      deps: { turnControl: { drainSteering } },
    });
    expect(result.stop).toEqual({ reason: "deadline", finalizer: true });
    expect(llm.requests.filter((r) => r.tools)).toHaveLength(4);
    const finalizer = llm.requests.at(-1)!;
    expect(finalizer.tools).toBeUndefined();
    const messages = finalizer.messages as {
      role: string;
      content: unknown;
    }[];
    const steerAt = messages.findIndex(
      (m) => m.role === "user" && m.content === interjection,
    );
    expect(steerAt).toBeGreaterThan(-1);
    // It precedes the request for this turn's narrative.
    const askAt = messages.findIndex(
      (m) =>
        m.role === "system" && String(m.content).includes(WRITE_STORY_TEXT),
    );
    expect(askAt).toBeGreaterThan(steerAt);
  });

  it("keeps stepping to the real deadline while the finalizer is not eligible", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    // requireToolUse with no successful business call: prose cannot complete
    // the runtime, so the reserve does not stop the loop.
    const failing = tool({
      name: "mark",
      description: "always fails",
      parameters: z.object({ note: z.string() }),
      async execute() {
        throw new Error("mark is down");
      },
    });
    const llm = clockedLLM({
      stepMs: 4_000,
      finalMs: 500,
      step: (n) => toolCall("mark", { note: `n${n}` }, `tc-${n}`),
    });
    const error = await thrownBy(
      runLoop({
        llm,
        maxSteps: 20,
        timeoutMs: 20_000,
        manifest: manifest({
          requireToolUse: true,
          loopProfile: { finalizer: { deadlineReserveMs: 5_000 } },
        }),
        deps: { toolExecutor: makeExecutor([failing]) },
      }),
    );
    expect(stopOf(error)).toEqual({ reason: "deadline" });
    // The fifth step started with 4 s left, inside the reserve.
    expect(llm.requests.filter((r) => r.tools)).toHaveLength(5);
    expect(llm.requests.every((r) => r.tools)).toBe(true);
  });

  it("uses at most half of the runtime's time as the reserve", async () => {
    // A 19 s reserve on a 20 s limit is cut to 10 s: the loop takes three
    // 4 s steps (8 s left), then the finalizer answers.
    const llm = clockedLLM({
      stepMs: 4_000,
      finalMs: 500,
      step: (n) => toolCall("mark", { note: `n${n}` }, `tc-${n}`),
    });
    const result = await runLoop({
      llm,
      maxSteps: 20,
      timeoutMs: 20_000,
      manifest: manifest({
        loopProfile: { finalizer: { deadlineReserveMs: 19_000 } },
      }),
      deps: { toolExecutor: makeExecutor([markTool]) },
    });
    expect(result.stop).toEqual({ reason: "deadline", finalizer: true });
    expect(llm.requests.filter((r) => r.tools)).toHaveLength(3);
  });
});

describe("settling a deadline", () => {
  function loopEndedBy(
    stop: AgentToolLoopCompleted["stop"],
  ): AgentToolLoopCompleted {
    return {
      finalContent: "The answer.",
      finalToolOutput: null,
      collectedToolCalls: [],
      executedToolCalls: [],
      failedToolCalls: [],
      pendingProposals: [],
      emittedEvents: [],
      streamDeltaCount: 0,
      stop,
      effectiveMaxSteps: 5,
      deadline: Date.now(),
      requiredToolUseUnmet: false,
      requiredCompletionUnmet: false,
    };
  }

  it("completes a deadline the finalizer answered", () => {
    const settled = settleAgentLoop({
      manifest: manifest(),
      input,
      runId: "run",
      startTime: Date.now(),
      toolLoop: loopEndedBy({ reason: "deadline", finalizer: true }),
    });
    expect(settled.kind).toBe("success");
    expect(settled.result.output).toBeTruthy();
    expect(settled.result.stop).toEqual({
      reason: "deadline",
      finalizer: true,
    });
  });

  it("fails a deadline alone as a timeout", () => {
    const settled = settleAgentLoop({
      manifest: manifest(),
      input,
      runId: "run",
      startTime: Date.now(),
      toolLoop: loopEndedBy({ reason: "deadline" }),
    });
    expect(settled.kind).toBe("failed");
    expect(settled.result.error).toContain("timed out while waiting");
    expect(settled.result.stop).toEqual({ reason: "deadline" });
  });
});

describe("the turn-level steering readers", () => {
  function closesOf(scheduled: readonly RuntimeManifest[]) {
    const closes: string[] = [];
    const readers = trackSteeringReaders({
      control: { closeSteering: () => closes.push("closed") },
      scheduled,
      eventFollowers: [],
    });
    return { closes, readers };
  }

  it("does not wait for a story whose profile turns steering off", () => {
    const { closes } = closesOf([story({ loopProfile: { steering: false } })]);
    expect(closes).toEqual(["closed"]);
  });

  it("waits for a story agent on the story preset", () => {
    const { closes, readers } = closesOf([story()]);
    expect(closes).toEqual([]);
    readers.settled("plug/story");
    expect(closes).toEqual(["closed"]);
  });
});
