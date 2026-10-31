import { afterEach, describe, expect, it } from "vitest";
import { createMemoryStore } from "@covel/store/memory";
import {
  createDefaultToolRegistry,
  createMemoryTools,
  FRAMEWORK_TOOL_NAMES,
} from "@covel/tools";
import type { CharacterSchemaRecord, TurnInput } from "@covel/shared";
import { createToolExecutor } from "../src/agent-loop/tool-executor.js";
import { executeToolSearch } from "../src/agent-loop/tool-search.js";
import { withSubagentDelegate } from "../src/agent-loop/subagent-delegate.js";
import { createExecutionContext } from "../src/turn-executor/execution-context.js";
import type { SubagentRunner } from "../src/agent-loop/subagent-runner.js";

const sessionId = "private-session-bookkeeping";
const rowId = "0b6f6a2e-3c1d-4f5a-9b7e-1a2b3c4d5e6f";
const turnId = "a4df4175-40c0-4c1a-b28a-b6797d1902fa";
const timestamp = "2026-10-14T08:00:00.000Z";
const bookkeeping = {
  id: rowId,
  sessionId,
  turnId,
  createdAt: timestamp,
  updatedAt: timestamp,
};
const value = {
  ...bookkeeping,
  nested: { ...bookkeeping, fact: "gate opened" },
};
const schema: CharacterSchemaRecord = {
  sessionId,
  version: 1,
  types: ["npc"],
  attributes: [],
  createdAt: timestamp,
  updatedAt: timestamp,
};
// Character handles are authored semantic IDs; nested row references remain UUIDs.
const character = {
  ...bookkeeping,
  id: "gate-keeper",
  name: "Aldric",
  type: "npc",
  version: 1,
  description: "Gate keeper",
  fields: { memory: value },
};
const inputs: Record<string, Record<string, unknown>> = {
  "render-ui": { parts: [{ id: "card", type: "card", content: value }] },
  "create-form": {
    formId: "opening",
    title: "Name",
    fields: [{ type: "text", name: "name", label: "Name" }],
    submitLabel: "Continue",
    narrativeTemplate: "I am {{name}}",
    validation: { name: "check", data: value },
  },
  "create-choices": {
    choiceId: "route",
    prompt: "Where?",
    choices: [
      { id: "gate", label: "Gate" },
      { id: "inn", label: "Inn" },
    ],
  },
  "create-notification": {
    level: "info",
    title: "Arrival",
    message: "Gate opened",
  },
  suspend: {
    reason: "Choose a route",
    fields: [{ type: "text", name: "answer", label: "Answer" }],
  },
  "runtime-done": { reason: "Finished" },
  "emit-event": { topic: "gate.opened", data: value },
  "sync-characters": {
    creates: [{ name: "Mira", type: "npc" }],
    updates: [{ id: "gate-keeper", description: "Friendly gate keeper" }],
  },
  "list-characters": {},
  "get-character": { name: "Aldric" },
  "memory-search": { query: "gate" },
  "world-dimension-get": { queries: [{ dimension: "discoveries" }] },
  "world-dimension-list": {},
  delegate: { target: { contract: "gate-actor@1" }, brief: "Greet them" },
};

function assertModelText(text: string): void {
  expect(text).not.toContain(sessionId);
  expect(text).not.toMatch(
    /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i,
  );
  expect(text).not.toMatch(
    /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})/,
  );
}

describe("builtin model-facing results", () => {
  const stores: ReturnType<typeof createMemoryStore>[] = [];
  afterEach(async () => {
    await Promise.all(stores.splice(0).map((store) => store.close()));
  });

  async function setup() {
    const store = createMemoryStore();
    stores.push(store);
    await store.createSession({
      id: sessionId,
      phase: "playing",
      status: "active",
      locale: "en",
      completedPlayerTurns: 1,
      setupRuntimes: {},
      seats: [
        { id: "main", controller: "human", role: "player", characters: "auto" },
      ],
      activePlugins: ["journal"],
      createdAt: timestamp,
      updatedAt: timestamp,
    });
    await store.upsertCharacterSchema(schema);
    await store.upsertCharacter(character);
    const registry = createDefaultToolRegistry({
      store,
      eventDirectory: {
        listTopics: async () => ["gate.opened"],
        validate: async () => ({ ok: true }),
      },
    });
    for (const module of createMemoryTools({
      search: async () => [
        {
          source: "recall",
          role: "assistant",
          content: "gate opened",
          score: 1,
          timestamp,
        },
        {
          source: "archival:lorebook",
          key: "gate-lore",
          content: "gate history",
          score: 1,
        },
      ],
    }))
      registry.registerBuiltin(module);
    const inner = createToolExecutor({
      findTool: (name, context) => registry.find(name, context.pluginId),
      store,
    });
    // `delegate` is answered by the agent loop's executor wrapper; the
    // sub-agent here returns a stored value with its bookkeeping.
    const runner: SubagentRunner = {
      inFlight: 0,
      privateTargetKind: () => undefined,
      run: async () => ({ ok: true, output: value, stopReason: "completed" }),
    };
    const input: TurnInput = {
      origin: "player",
      sessionId,
      turnId,
      playerMessage: "",
    };
    const executor = withSubagentDelegate(inner, runner, {
      caller: { pluginId: "journal", runtimeId: "journal/record", depth: 0 },
      input,
      deps: {
        llm: {
          generate: async () => {
            throw new Error("no model in this test");
          },
        },
        loadRuntime: async () => undefined,
      },
      executionContext: createExecutionContext(input),
    });
    const context = {
      sessionId,
      turnId,
      pluginId: "journal",
      runtimeId: "journal/record",
      authorizedToolNames: new Set(Object.keys(inputs)),
      world: {
        characterSchema: schema,
        characters: [character],
        dimensions: {
          discoveries: {
            name: "Discoveries",
            schema: { type: "object" as const },
            value,
            version: 1,
          },
        },
        seats: [],
      },
    };
    return { registry, executor, context };
  }

  it("requires a successful fixture for every registered builtin, including optional and virtual tools", async () => {
    const { registry } = await setup();
    expect([...registry.builtinTools.keys()].sort()).toEqual(
      Object.keys(inputs).sort(),
    );
    expect([...registry.builtinTools.keys(), "search-tools"].sort()).toEqual(
      [...FRAMEWORK_TOOL_NAMES].sort(),
    );
  });

  it.each(Object.entries(inputs))(
    "%s sends no row UUID, session ID or timestamp to the model",
    async (name, args) => {
      const { executor, context } = await setup();
      const result = await executor.execute(
        { toolCallId: rowId, name, arguments: JSON.stringify(args) },
        context,
      );
      expect(result.success, result.result).toBe(true);
      assertModelText(result.result);
    },
  );

  it("search-tools sends only matching tool definitions", async () => {
    const { registry, executor, context } = await setup();
    const result = executeToolSearch({
      argumentsJson: '{"query":"character"}',
      deferredNames: new Set(registry.builtinTools.keys()),
      activeNames: new Set(),
      toolExecutor: executor,
      context,
    });
    expect(result.activated.length).toBeGreaterThan(0);
    assertModelText(result.resultText);
    assertModelText(JSON.stringify(result.activated));
  });

  it.each([
    "sessionId",
    "id",
    "createdAt",
    "nested.turnId",
    "/nested/updatedAt",
  ])("dimension path %s cannot bypass the model projection", async (path) => {
    const { executor, context } = await setup();
    const result = await executor.execute(
      {
        toolCallId: rowId,
        name: "world-dimension-get",
        arguments: JSON.stringify({
          queries: [{ dimension: "discoveries", path }],
        }),
      },
      context,
    );
    expect(result.success, result.result).toBe(true);
    assertModelText(result.result);
    expect(result.result).toContain("not found");
    expect(result.parsedResult).toMatchObject({ results: [{ found: true }] });
  });
});
