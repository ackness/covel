import { afterEach, describe, expect, it, vi } from "vitest";
import { createMemoryStore } from "@covel/store/memory";
import { createEventBus } from "@covel/events";
import { AiProviderError } from "@covel/ai-provider";
import type {
  LLMAdapter,
  LLMStreamEvent,
  SubscriptionEvent,
  TurnInput,
} from "@covel/shared";
import {
  commitExecution,
  createHookPipeline,
  createTurnEmitter,
  executeTurn,
} from "../src/index.js";
import {
  makeExecutor,
  manifest,
  markTool,
  submitted,
} from "./_helpers/agent-loop-fixture.js";

afterEach(() => vi.restoreAllMocks());

async function fixture() {
  const store = createMemoryStore();
  const now = new Date().toISOString();
  await store.createSession({
    id: "session",
    locale: "en-US",
    status: "active",
    phase: "playing",
    activePlugins: ["plug"],
    completedPlayerTurns: 0,
    setupRuntimes: {},
    seats: [
      { id: "main", controller: "human", role: "player", characters: "auto" },
    ],
    createdAt: now,
    updatedAt: now,
  });
  const runtime = manifest({ outputKind: "story", maxRetries: 1 });
  const input: TurnInput = {
    origin: "player",
    sessionId: "session",
    turnId: "turn",
    playerMessage: "Go",
    locale: "en-US",
  };
  const events: SubscriptionEvent[] = [];
  const eventBus = createEventBus(store);
  eventBus.onEmit((event) => events.push(event));
  const emitter = createTurnEmitter({
    store,
    eventBus,
    sessionId: "session",
    turnId: "turn",
  });
  const hooks = createHookPipeline();
  const work = vi.fn(markTool.execute);
  const deps = (llm: LLMAdapter) => ({
    store,
    llm,
    eventBus,
    emitter,
    hookPipeline: hooks,
    toolExecutor: makeExecutor([{ ...markTool, execute: work }]),
    loadRuntime: async () => ({
      manifest: runtime,
      promptTemplate: "Submit the story.",
    }),
  });
  const commit = (
    execution: Awaited<ReturnType<typeof executeTurn>>,
    rollback = false,
  ) =>
    commitExecution({
      store,
      eventBus,
      emitter,
      execution,
      completion: { kind: "turn", turnId: input.turnId, durationMs: 0 },
      ...(rollback
        ? {
            extraInTx: async () => {
              throw new Error("rollback");
            },
          }
        : {}),
    });
  return { store, runtime, input, events, hooks, work, deps, commit };
}

function completed(text: string): LLMStreamEvent[] {
  return [
    { type: "tool-call", ...submitted(text).toolCalls[0]! },
    {
      type: "done",
      finishReason: "tool_calls",
      usage: { inputTokens: 3, outputTokens: 2 },
    },
  ];
}

function scripted(scripts: readonly (readonly (LLMStreamEvent | Error)[])[]) {
  let attempts = 0;
  const generate = vi.fn<LLMAdapter["generate"]>(async () =>
    submitted("Recovered story."),
  );
  const stream = vi.fn<NonNullable<LLMAdapter["stream"]>>(async function* () {
    const script = scripts[attempts++];
    if (!script) throw new Error("unexpected stream attempt");
    for (const event of script) {
      if (event instanceof Error) throw event;
      yield event;
    }
  });
  return { generate, stream };
}

describe("internal provider streams and committed story delivery", () => {
  it("reports progress while a slow tool response is pending, then publishes once after commit", async () => {
    const f = await fixture();
    let release!: () => void;
    const waiting = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const llm: LLMAdapter = {
      generate: async () => {
        throw new Error("stream expected");
      },
      stream: async function* () {
        yield { type: "tool-argument-delta" };
        entered();
        await waiting;
        yield* completed("Whole story.");
      },
    };
    const pending = executeTurn(f.input, [f.runtime], f.deps(llm));
    await started;
    expect(f.events.some((event) => event.type === "step.started")).toBe(true);
    expect(f.events.some((event) => event.type.startsWith("narrative."))).toBe(
      false,
    );
    expect(await f.store.listMessages("session")).toEqual([]);
    release();
    const execution = await pending;
    expect(execution.result.runtimeResults[0]?.status).toBe("success");
    expect(f.events.some((event) => event.type === "tool.completed")).toBe(
      true,
    );
    expect(f.events.some((event) => event.type.startsWith("narrative."))).toBe(
      false,
    );
    const outcome = await f.commit(execution);
    expect(outcome.status).toBe("committed");
    const stories = outcome.events.filter(
      (event) => event.type === "narrative.completed",
    );
    expect(stories).toHaveLength(1);
    const messages = await f.store.listMessages("session");
    expect(
      messages.find((message) => message.id === stories[0]?.payload.messageId)
        ?.content,
    ).toBe("Whole story.");
  });

  it("reports a safe rejection note and commits only the corrected submission", async () => {
    const f = await fixture();
    let reviews = 0;
    f.hooks.register({
      id: "review",
      event: "ReviewAgentOutput",
      handler: async () =>
        ++reviews === 1
          ? {
              action: "continue",
              replace: { correction: "Private rejected quotation." },
            }
          : { action: "continue" },
    });
    const execution = await executeTurn(
      f.input,
      [f.runtime],
      f.deps(
        scripted([completed("Rejected story."), completed("Corrected story.")]),
      ),
    );
    const note = f.events.filter((event) => event.type === "step.completed")[0];
    expect(note?.payload).toMatchObject({
      runtimeId: f.runtime.name,
      pluginId: f.runtime.pluginId,
      turnId: "turn",
      runId: execution.result.runtimeResults[0]?.runId,
      step: 1,
      notes: [
        { kind: "output-rejected", reason: "review-rejected", attempt: 1 },
      ],
    });
    expect(JSON.stringify(note)).not.toContain("Private rejected");
    expect(f.events.some((event) => event.type.startsWith("narrative."))).toBe(
      false,
    );
    const outcome = await f.commit(execution);
    expect(outcome.status).toBe("committed");
    expect(
      outcome.events.filter((event) => event.type === "narrative.completed"),
    ).toHaveLength(1);
    expect(
      (await f.store.listMessages("session")).map((message) => message.content),
    ).toEqual(["Corrected story."]);
  });

  it("publishes no story when an accepted candidate rolls back", async () => {
    const f = await fixture();
    const execution = await executeTurn(
      f.input,
      [f.runtime],
      f.deps(scripted([completed("Unsaved story.")])),
    );
    expect(execution.result.runtimeResults[0]?.status).toBe("success");
    expect((await f.commit(execution, true)).status).toBe("failed");
    expect(f.events.some((event) => event.type.startsWith("narrative."))).toBe(
      false,
    );
    expect(await f.store.listMessages("session")).toEqual([]);
    expect(await f.store.listTurnMessages("session")).toEqual([]);
  });

  it("discards failed text, calls and continuation, retaining billed usage and bounded retries", async () => {
    const f = await fixture();
    const llm = scripted([
      [
        { type: "text-delta", textDelta: "Failed draft." },
        { type: "tool-argument-delta" },
        {
          type: "tool-call",
          id: "partial",
          name: "mark",
          arguments: '{"note":"must not run"}',
        },
        {
          type: "done",
          finishReason: "error",
          usage: { inputTokens: 7, outputTokens: 5 },
        },
      ],
      completed("Fresh story."),
    ]);
    const execution = await executeTurn(f.input, [f.runtime], f.deps(llm));
    expect(llm.stream).toHaveBeenCalledTimes(2);
    expect(llm.generate).not.toHaveBeenCalled();
    expect(f.work).not.toHaveBeenCalled();
    expect(execution.result.runtimeResults[0]?.output).toMatchObject({
      narrativeOutput: "Fresh story.",
      segments: [{ kind: "narration", text: "Fresh story." }],
    });
    const responses = f.events.filter(
      (event) => event.type === "llm.responded",
    );
    expect(responses.map((event) => event.payload.usage)).toEqual([
      { inputTokens: 7, outputTokens: 5 },
      { inputTokens: 3, outputTokens: 2 },
    ]);
    expect((await f.commit(execution)).status).toBe("committed");
    expect(JSON.stringify(await f.store.listMessages("session"))).not.toContain(
      "Failed draft",
    );
  });

  it.each(["refusal", "cancel"] as const)(
    "does not execute complete arguments followed by %s",
    async (failure) => {
      const f = await fixture();
      const aborter = new AbortController();
      const llm: LLMAdapter = {
        generate: vi.fn(async () => submitted("Never.")),
        stream: async function* () {
          yield { type: "tool-call", ...submitted("Never.").toolCalls[0]! };
          if (failure === "refusal")
            throw new AiProviderError({
              code: "REFUSAL",
              provider: "test",
              message: "Refused",
              retriable: false,
            });
          aborter.abort();
          yield { type: "done", finishReason: "tool_calls" };
        },
      };
      const execution = await executeTurn(f.input, [f.runtime], {
        ...f.deps(llm),
        turnControl: { signal: aborter.signal },
      });
      expect(
        execution.result.runtimeResults.every(
          (result) => result.status !== "success",
        ),
      ).toBe(true);
      expect(llm.generate).not.toHaveBeenCalled();
      expect((await f.commit(execution)).status).toBe("failed");
      expect(
        f.events.some((event) => event.type.startsWith("narrative.")),
      ).toBe(false);
      expect(await f.store.listMessages("session")).toEqual([]);
    },
  );

  it("recovers a failed hidden stream using one non-stream request", async () => {
    const f = await fixture();
    const llm = scripted([
      [new Error("fetch failed")],
      [new Error("fetch failed")],
    ]);
    const execution = await executeTurn(f.input, [f.runtime], f.deps(llm));
    expect(llm.stream).toHaveBeenCalledTimes(2);
    expect(llm.generate).toHaveBeenCalledOnce();
    expect(execution.result.runtimeResults[0]?.status).toBe("success");
    expect((await f.commit(execution)).status).toBe("committed");
  });
});
