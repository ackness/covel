/**
 * Sub-agents against a real store: the execution commits, the trace is
 * persisted through the turn emitter, and a resumed runtime delegates.
 *
 * - A caller's own writes persist while a sub-agent's attempted write never
 *   reaches the store (it produces no proposals and forms no commit unit).
 * - `subagent.started` / `subagent.completed` and the sub-agent's own events
 *   are persisted trace rows carrying the call tree.
 * - A runtime resumed after suspension still resolves its sub-agent's model
 *   through the session's `runtimeModelOverrides`.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { createMemoryStore } from "@covel/store/memory";
import type { DataStore, TraceEventRecord } from "@covel/store";
import type {
  LLMAdapter,
  LLMResponse,
  RuntimeManifest,
  SubagentResult,
  TurnInput,
} from "@covel/shared";
import type {
  FunctionHandler,
  LoadedRuntime,
} from "@covel/shared/plugin-runtime";
import { delegateTool, suspendTool, ToolRegistry } from "@covel/tools";
import {
  commitExecution,
  createToolExecutor,
  createTurnEmitter,
  executeTurn,
  resumeSuspendedRuntime,
} from "../src/index.js";

const SESSION = "sess-sub-store";
const CONTRACT = "test-actor@1";
const ACTOR_MARK = "ACTOR-PROMPT";
const PARENT_MARK = "PARENT-PROMPT";
const LINE_SCHEMA = {
  type: "object",
  properties: { line: { type: "string" } },
  required: ["line"],
  additionalProperties: false,
} as const;
const timestamp = "2026-10-29T00:00:00.000Z";

const input: TurnInput = {
  origin: "player",
  sessionId: SESSION,
  turnId: "turn-1",
  playerMessage: "Open the gate",
  locale: "en-US",
};

const open: DataStore[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(open.splice(0).map((store) => store.close()));
});

// ── Fixtures ────────────────────────────────────────────────────────

/** A dataset of short notes, keyed by the caller. */
const NOTES = {
  notes: {
    namespace: "notes",
    schema: "./schemas/note.json",
    ops: ["set"],
    tools: ["get", "list", "upsert"],
  },
} as const satisfies RuntimeManifest["datasets"];
const NOTE_SCHEMAS = { notes: { type: "string" } };

/** The provider: it declares a write tool, which the kernel takes away. */
const guard: RuntimeManifest = {
  name: "actor-pkg/guard",
  pluginId: "actor-pkg",
  description: "guard",
  runtimeType: "agent",
  outputKind: "system",
  subagentOnly: true,
  trigger: { type: "manual" },
  outputContract: CONTRACT,
  output: { schema: "output.schema.json" },
  model: "actor-slot",
  tools: { datasets: [{ dataset: "notes", tools: ["upsert", "get"] }] },
  datasets: NOTES,
};

function json(value: unknown): LLMResponse {
  return {
    content: JSON.stringify(value),
    toolCalls: [],
    finishReason: "stop",
    usage: { inputTokens: 7, outputTokens: 3 },
  };
}

function calls(
  ...list: { name: string; args: object; id: string }[]
): LLMResponse {
  return {
    content: null,
    toolCalls: list.map(({ name, args, id }) => ({
      id,
      name,
      arguments: JSON.stringify(args),
    })),
    finishReason: "tool_calls",
    usage: { inputTokens: 5, outputTokens: 2 },
  };
}

function call(name: string, args: object, id: string): LLMResponse {
  return calls({ name, args, id });
}

type Reply = (index: number) => LLMResponse;

/** Routes each request by the marker in its system prompt. */
function routedLLM(routes: Record<string, Reply>) {
  const models: { mark: string; model?: string }[] = [];
  const counts = new Map<string, number>();
  const llm: LLMAdapter = {
    async generate(params) {
      const system = params.messages
        .filter((message) => message.role === "system")
        .map((message) => String(message.content))
        .join("\n");
      const mark = Object.keys(routes).find((key) => system.includes(key));
      if (!mark) throw new Error("unrouted model request");
      models.push({
        mark,
        ...(params.model !== undefined ? { model: params.model } : {}),
      });
      const index = counts.get(mark) ?? 0;
      counts.set(mark, index + 1);
      return routes[mark]!(index);
    },
  };
  return { llm, models };
}

/** The provider tries to write; then it answers. */
const guardReplies: Reply = (index) =>
  index === 0
    ? call("notes-upsert", { key: "guard", record: "leaked" }, "tc-guard-write")
    : json({ line: "Halt!" });

async function seeded(activePlugins: string[]) {
  const store = createMemoryStore();
  open.push(store);
  await store.createSession({
    id: SESSION,
    locale: "en-US",
    status: "active",
    phase: "playing",
    setupRuntimes: {},
    seats: [
      { id: "main", controller: "human", role: "player", characters: "auto" },
    ],
    activePlugins,
    completedPlayerTurns: 1,
    createdAt: timestamp,
    updatedAt: timestamp,
  });
  return store;
}

function deps(args: {
  store: DataStore;
  llm: LLMAdapter;
  runtimes: readonly RuntimeManifest[];
  handlers?: Record<string, FunctionHandler>;
  turnId?: string;
}) {
  const registry = new ToolRegistry();
  registry.registerBuiltin(delegateTool);
  registry.registerBuiltin(suspendTool);
  const loaded = new Map<string, LoadedRuntime>(
    args.runtimes.map((manifest) => [
      manifest.name,
      manifest.runtimeType === "function"
        ? {
            manifest,
            promptTemplate: "",
            ...(args.handlers?.[manifest.name]
              ? { handler: args.handlers[manifest.name] }
              : {}),
          }
        : {
            manifest,
            promptTemplate: manifest.subagentOnly
              ? `${ACTOR_MARK} You are the gate guard.`
              : `${PARENT_MARK} You direct the scene.`,
            outputSchema: { ...LINE_SCHEMA },
            datasetSchemas: NOTE_SCHEMAS,
            ...(manifest.outputContract
              ? { outputContractSchema: { ...LINE_SCHEMA } }
              : {}),
          },
    ]),
  );
  return {
    store: args.store,
    llm: args.llm,
    loadRuntime: async (manifest: RuntimeManifest) => loaded.get(manifest.name),
    toolExecutor: createToolExecutor({
      store: args.store,
      findTool: (name, context) => registry.find(name, context.pluginId),
      getToolSource: (name) => registry.source(name),
    }),
    resolveModel: (manifest: RuntimeManifest, override?: string) =>
      override ?? manifest.model,
    emitter: createTurnEmitter({
      store: args.store,
      sessionId: SESSION,
      turnId: args.turnId ?? input.turnId,
    }),
  };
}

async function notes(store: DataStore, pluginId: string) {
  return Object.fromEntries(
    (await store.listPluginData(SESSION, pluginId, "notes")).map((row) => [
      row.key,
      row.value,
    ]),
  );
}

async function persisted(store: DataStore, type: string) {
  const rows: TraceEventRecord[] = await store.queryTraceEvents(SESSION, {
    types: [type],
  });
  return rows.map((row) => row.payload as Record<string, unknown>);
}

// ── Tests ───────────────────────────────────────────────────────────

describe("sub-agents at commit", () => {
  it("commits a function caller's write and never the sub-agent's attempted write", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const store = await seeded(["caller-pkg", "actor-pkg"]);
    const caller: RuntimeManifest = {
      name: "caller-pkg/main",
      pluginId: "caller-pkg",
      description: "caller",
      runtimeType: "function",
      stage: "narrative",
      outputKind: "system",
      trigger: { type: "auto" },
    };
    let answer: SubagentResult | undefined;
    const handler: FunctionHandler = async (ctx) => {
      await ctx.pluginData!.set("notes", "caller", "kept");
      answer = await ctx.agents!.run({
        target: { contract: CONTRACT },
        brief: "A stranger asks to pass.",
      });
      return { outcome: "success", value: {} };
    };
    const { llm } = routedLLM({ [ACTOR_MARK]: guardReplies });
    const execution = await executeTurn(
      input,
      [caller, guard],
      deps({
        store,
        llm,
        runtimes: [caller, guard],
        handlers: { [caller.name]: handler },
      }),
    );
    const outcome = await commitExecution({
      store,
      execution,
      completion: { kind: "turn", turnId: input.turnId, durationMs: 0 },
    });

    expect(outcome.status).toBe("committed");
    expect(answer).toMatchObject({ ok: true, output: { line: "Halt!" } });
    expect(execution.commit.results.map((r) => r.runtimeId)).toEqual([
      caller.name,
    ]);
    expect(await notes(store, "caller-pkg")).toEqual({ caller: "kept" });
    expect(await notes(store, "actor-pkg")).toEqual({});

    // The refused write is on record, attributed to the sub-agent run.
    const [started] = await persisted(store, "subagent.started");
    const refusal = (await persisted(store, "tool.failed")).find(
      (payload) => payload.toolName === "notes-upsert",
    );
    expect(refusal).toMatchObject({
      code: "unavailable",
      runtimeId: guard.name,
      subagentCallId: started?.subagentCallId,
      parentRuntimeId: caller.name,
    });
    expect(await persisted(store, "subagent.writes-dropped")).toEqual([]);
  });

  it("commits a delegating agent's write and persists the sub-agent trace under its tool call", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const store = await seeded(["director", "actor-pkg"]);
    const director: RuntimeManifest = {
      name: "director/lead",
      pluginId: "director",
      description: "director",
      runtimeType: "agent",
      outputKind: "system",
      stage: "narrative",
      trigger: { type: "auto" },
      output: { schema: "output.schema.json" },
      tools: {
        builtin: ["delegate"],
        datasets: [{ dataset: "notes", tools: ["upsert"] }],
      },
      datasets: NOTES,
    };
    const { llm } = routedLLM({
      [PARENT_MARK]: (index) =>
        index === 0
          ? calls(
              {
                name: "notes-upsert",
                args: { key: "director", record: "kept" },
                id: "tc-director-write",
              },
              {
                name: "delegate",
                args: {
                  target: { contract: CONTRACT },
                  brief: "Challenge the stranger.",
                },
                id: "tc-delegate",
              },
            )
          : json({ line: "The guard spoke." }),
      [ACTOR_MARK]: guardReplies,
    });
    const execution = await executeTurn(
      input,
      [director, guard],
      deps({ store, llm, runtimes: [director, guard] }),
    );
    const outcome = await commitExecution({
      store,
      execution,
      completion: { kind: "turn", turnId: input.turnId, durationMs: 0 },
    });

    expect(outcome.status).toBe("committed");
    expect(await notes(store, "director")).toEqual({ director: "kept" });
    expect(await notes(store, "actor-pkg")).toEqual({});

    // Persisted rows: the delegate call, the sub-agent run under it, and the
    // sub-agent's own steps pointing back at the call.
    const delegateDone = (await persisted(store, "tool.completed")).find(
      (payload) => payload.toolName === "delegate",
    );
    expect(delegateDone).toMatchObject({
      runtimeId: director.name,
      toolCallId: "tc-delegate",
      approvalStatus: "auto-allowed",
      result: '{"data":{"line":"Halt!"}}',
    });
    const [started] = await persisted(store, "subagent.started");
    const [completed] = await persisted(store, "subagent.completed");
    const tree = {
      subagentCallId: started?.subagentCallId,
      parentCallId: "tc-delegate",
      parentRuntimeId: director.name,
    };
    expect(started).toMatchObject({
      ...tree,
      parentPluginId: "director",
      runtimeId: guard.name,
      pluginId: "actor-pkg",
    });
    expect(typeof started?.subagentCallId).toBe("string");
    expect(completed).toMatchObject({
      ...tree,
      runtimeId: guard.name,
      stopReason: "completed",
      usage: { inputTokens: 12, outputTokens: 5 },
    });
    const subSteps = (await persisted(store, "step.completed")).filter(
      (payload) => payload.runtimeId === guard.name,
    );
    expect(subSteps.length).toBeGreaterThan(0);
    for (const step of subSteps) expect(step).toMatchObject(tree);
  });
});

describe("sub-agents after resume", () => {
  it("resolves the sub-agent's slot through the session override on a resumed delegation", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const store = await seeded(["director", "actor-pkg"]);
    const director: RuntimeManifest = {
      name: "director/lead",
      pluginId: "director",
      description: "director",
      runtimeType: "agent",
      outputKind: "system",
      stage: "narrative",
      trigger: { type: "auto" },
      output: { schema: "output.schema.json" },
      model: "lead-slot",
      tools: { builtin: ["delegate", "suspend"] },
      maxRetries: 0,
    };
    const { llm, models } = routedLLM({
      [PARENT_MARK]: (index) =>
        index === 0
          ? call(
              "suspend",
              {
                reason: "Confirm",
                fields: [{ type: "text", name: "answer", label: "Answer" }],
              },
              "tc-suspend",
            )
          : index === 1
            ? call(
                "delegate",
                { target: { contract: CONTRACT }, brief: "Challenge them." },
                "tc-delegate",
              )
            : json({ line: "The guard spoke." }),
      [ACTOR_MARK]: () => json({ line: "Who goes there?" }),
    });
    const overrides = {
      "director/lead": "lead-session-slot",
      "actor-pkg/guard": "guard-session-slot",
    };
    const turnDeps = deps({ store, llm, runtimes: [director, guard] });
    const execution = await executeTurn(
      { ...input, runtimeModelOverrides: overrides },
      [director, guard],
      turnDeps,
    );
    expect(execution.result.runtimeResults[0]?.status).toBe("suspended");
    await commitExecution({
      store,
      execution,
      completion: { kind: "turn", turnId: input.turnId, durationMs: 0 },
    });
    const [suspension] = await store.listSuspensions(SESSION);

    const resumed = await resumeSuspendedRuntime(
      suspension!,
      {},
      director,
      turnDeps,
      { activeRuntimes: [director, guard], runtimeModelOverrides: overrides },
    );

    expect(resumed.result.status).toBe("success");
    expect(resumed.result.output).toEqual({ line: "The guard spoke." });
    expect(models).toEqual([
      { mark: PARENT_MARK, model: "lead-session-slot" },
      { mark: PARENT_MARK, model: "lead-session-slot" },
      { mark: ACTOR_MARK, model: "guard-session-slot" },
      { mark: PARENT_MARK, model: "lead-session-slot" },
    ]);
  });
});
