/**
 * Dataset tools: an agent that lists a dataset of its own package in
 * `agent.tools.datasets` gets `<dataset>-get`, `-list`, `-upsert` and
 * `-update`, built at run start from the dataset's declaration and record
 * schema. Reads see the run's buffered writes and same-plugin upstream
 * writes; writes are checked before anything is staged, then staged as one
 * `plugin.data.update`. Keys follow the dataset key rule, after an exact
 * match.
 */

import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createMemoryStore } from "@covel/store/memory";
import type { DataStore } from "@covel/store";
import {
  defaultSessionSeats,
  type DatasetToolKind,
  type JsonValue,
  type LLMAdapter,
  type LLMMessage,
  type LLMResponse,
  type LLMToolDefinition,
  type PluginDatasetDecl,
  type Proposal,
  type RuntimeManifest,
  type RuntimeResult,
  type TurnInput,
} from "@covel/shared";
import type { LoadedRuntime } from "@covel/shared/plugin-runtime";
import { suspendTool, ToolRegistry, validateOutput } from "@covel/tools";
import {
  commitExecution,
  executeTurn,
  resumeSuspendedRuntime,
} from "../src/index.js";
import { createToolExecutor } from "../src/agent-loop/tool-executor.js";
import {
  prepareAgentToolSurface,
  withAgentToolSurface,
} from "../src/agent-loop/agent-tool-surface.js";
import { createDatasetTools } from "../src/agent-loop/dataset-tools.js";

const SESSION = "session";
const P = "probe";
const MARK = "KEEPER-PROMPT";
const HELPER_MARK = "HELPER-PROMPT";
const UPSTREAM_MARK = "UPSTREAM-PROMPT";
const timestamp = "2026-10-31T00:00:00.000Z";
const input: TurnInput = {
  sessionId: SESSION,
  turnId: "turn",
  playerMessage: "Who is here?",
  origin: "player",
  locale: "en",
};
const ALL: readonly DatasetToolKind[] = ["get", "list", "upsert", "update"];
const STAGED_NOTICE =
  "Staged: it takes effect when the turn ends and may still be rejected.";

const npcSchema = {
  $schema: "http://json-schema.org/draft-07/schema#",
  type: "object",
  properties: {
    name: { type: "string" },
    mood: { type: "string" },
    trust: { type: "integer", minimum: 0, maximum: 100 },
    tags: { type: "array", items: { type: "string" } },
  },
  required: ["name"],
};
const journalSchema = {
  type: "object",
  properties: { text: { type: "string" } },
  required: ["text"],
};

const DATASETS: Record<string, PluginDatasetDecl> = {
  npcs: {
    namespace: "npcs",
    schema: "./schemas/npc.json",
    key: "name",
    ops: ["set", "merge", "inc", "append", "delete"],
    tools: [...ALL],
    description: "People the hero has met.",
  },
  journal: {
    namespace: "journal",
    schema: "./schemas/journal.json",
    ops: ["set", "merge"],
    tools: [...ALL],
  },
};
const SCHEMAS = { npcs: npcSchema, journal: journalSchema };

function agent(extra: Partial<RuntimeManifest> = {}): RuntimeManifest {
  return {
    name: `${P}/keeper`,
    pluginId: P,
    description: "keeper",
    runtimeType: "agent",
    stage: "narrative",
    outputKind: "story",
    trigger: { type: "auto" },
    tools: { datasets: [{ dataset: "npcs", tools: [...ALL] }] },
    datasets: DATASETS,
    maxRetries: 0,
    ...extra,
  };
}

interface Request {
  readonly mark: string;
  readonly tools: readonly LLMToolDefinition[];
  readonly messages: readonly LLMMessage[];
}
type Reply = (index: number, request: Request) => LLMResponse;

function text(content: string): LLMResponse {
  return {
    content,
    toolCalls: [],
    finishReason: "stop",
    usage: { inputTokens: 1, outputTokens: 1 },
  };
}
function call(name: string, args: object, id = `call-${name}`): LLMResponse {
  return {
    content: null,
    toolCalls: [{ id, name, arguments: JSON.stringify(args) }],
    finishReason: "tool_calls",
    usage: { inputTokens: 1, outputTokens: 1 },
  };
}

/** Routes each request by the marker in its system prompt. */
function scripted(routes: Record<string, Reply>) {
  const requests: Request[] = [];
  const counts = new Map<string, number>();
  const llm: LLMAdapter = {
    async generate(params) {
      const system = params.messages
        .filter((message) => message.role === "system")
        .map((message) => String(message.content))
        .join("\n");
      const mark = Object.keys(routes).find((key) => system.includes(key));
      if (!mark) throw new Error("unrouted model request");
      const request = {
        mark,
        tools: params.tools ?? [],
        messages: params.messages,
      };
      requests.push(request);
      const index = counts.get(mark) ?? 0;
      counts.set(mark, index + 1);
      return routes[mark]!(index, request);
    },
  };
  return { llm, requests };
}

/** The model-facing text of the last tool answer in a request. */
function toolMessage(request: Request | undefined): unknown {
  const message = request?.messages.findLast((item) => item.role === "tool");
  return message ? JSON.parse(String(message.content)) : undefined;
}
/** Every tool answer in a request, in order. */
function toolMessages(request: Request | undefined): unknown[] {
  return (request?.messages ?? [])
    .filter((item) => item.role === "tool")
    .map((item) => JSON.parse(String(item.content)));
}

const open: DataStore[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(open.splice(0).map((store) => store.close()));
});

async function fixture(options: { withStore?: boolean } = {}) {
  const store = createMemoryStore();
  open.push(store);
  await store.createSession({
    id: SESSION,
    locale: "en",
    status: "active",
    phase: "playing",
    setupRuntimes: {},
    activePlugins: [P, "other", "narrator"],
    completedPlayerTurns: 0,
    seats: defaultSessionSeats(),
    createdAt: timestamp,
    updatedAt: timestamp,
  });
  const tools = new ToolRegistry();
  tools.registerBuiltin(suspendTool);
  const toolExecutor = createToolExecutor({
    ...(options.withStore === false ? {} : { store }),
    findTool: (name, context) => tools.find(name, context.pluginId),
    getToolSource: (name) => tools.source(name),
  });
  const loadRuntime = async (
    manifest: RuntimeManifest,
  ): Promise<LoadedRuntime> => ({
    manifest,
    promptTemplate: manifest.subagentOnly
      ? `${HELPER_MARK} You help.`
      : `${MARK} You keep track of people.`,
    datasetSchemas: SCHEMAS,
  });
  const deps = (llm: LLMAdapter) => ({
    store,
    toolExecutor,
    llm,
    loadRuntime,
  });
  const seed = async (
    namespace: string,
    key: string,
    value: JsonValue,
    pluginId = P,
  ) =>
    store.setPluginData({
      id: `${SESSION}:${pluginId}:${namespace}:${key}`,
      sessionId: SESSION,
      pluginId,
      namespace,
      key,
      value,
      createdAt: timestamp,
      updatedAt: timestamp,
    });
  const stored = async (namespace: string, key: string) =>
    (await store.getPluginData(SESSION, P, namespace, key))?.value;
  const context = {
    sessionId: SESSION,
    turnId: input.turnId,
    pluginId: P,
    runtimeId: `${P}/keeper`,
  };
  /** Call one dataset tool directly, as the agent would. */
  const direct = async (
    name: string,
    args: unknown,
    manifest: RuntimeManifest = agent(),
  ) => {
    const surface = withAgentToolSurface(
      toolExecutor,
      await prepareAgentToolSurface({
        manifest,
        input,
        deps: { loadRuntime },
      }),
      undefined,
    );
    return surface.execute(
      {
        toolCallId: `direct-${name}`,
        name,
        arguments: JSON.stringify(args),
      },
      context,
    );
  };
  const commit = (execution: Awaited<ReturnType<typeof executeTurn>>) =>
    commitExecution({
      store,
      execution,
      completion: { kind: "turn", turnId: input.turnId, durationMs: 0 },
    });
  return {
    store,
    toolExecutor,
    deps,
    loadRuntime,
    seed,
    stored,
    direct,
    commit,
    context,
  };
}

const resultOf = (
  execution: Awaited<ReturnType<typeof executeTurn>>,
  runtimeId = `${P}/keeper`,
) =>
  (execution.result.runtimeResults as readonly RuntimeResult[]).find(
    (result) => result.runtimeId === runtimeId,
  );

/** The full result the commit plan holds, buffered proposals included. */
const planned = (
  execution: Awaited<ReturnType<typeof executeTurn>>,
  runtimeId = `${P}/keeper`,
) =>
  (execution.commit.results as readonly RuntimeResult[]).find(
    (result) => result.runtimeId === runtimeId,
  );

const proposalsOf = (result: { pendingProposals?: readonly Proposal[] }) =>
  (result.pendingProposals ?? []).map((proposal) => ({
    type: proposal.type,
    payload: proposal.payload,
  }));

describe("dataset tools offered to an agent", () => {
  it("are the selected tools, with schemas, annotations and descriptions from the declaration", async () => {
    const { deps, toolExecutor, loadRuntime, context } = await fixture();
    const { llm, requests } = scripted({ [MARK]: () => text("Nobody yet.") });
    try {
      await executeTurn(input, [agent()], deps(llm));
      const offered = new Map(
        requests[0]!.tools.map((tool) => [tool.name, tool]),
      );
      expect([...offered.keys()].sort()).toEqual([
        "npcs-get",
        "npcs-list",
        "npcs-update",
        "npcs-upsert",
      ]);
      const { $schema: _drop, ...record } = npcSchema;
      const upsert = offered.get("npcs-upsert")!;
      expect(upsert.parameters).toMatchObject({
        type: "object",
        required: ["record"],
        additionalProperties: false,
      });
      expect(
        (upsert.parameters as { properties: { record: unknown } }).properties
          .record,
      ).toEqual(record);
      const update = offered.get("npcs-update")!.parameters as {
        properties: {
          ops: {
            items: {
              anyOf: { properties: { op: { enum: string[] } } }[];
            };
          };
        };
      };
      expect(
        update.properties.ops.items.anyOf.map(
          (schema) => schema.properties.op.enum[0],
        ),
      ).toEqual(["merge", "inc", "append", "delete"]);
      for (const tool of offered.values()) {
        expect(tool.description).toContain("People the hero has met.");
        expect(tool.description).not.toContain(P);
      }
      const surface = withAgentToolSurface(
        toolExecutor,
        await prepareAgentToolSurface({
          manifest: agent(),
          input,
          deps: { loadRuntime },
        }),
        undefined,
      );
      const annotations = (name: string) =>
        surface.getToolInfo(name, context)?.annotations;
      const read = {
        readOnly: true,
        stagesWrites: false,
        idempotent: true,
        concurrencySafe: true,
      };
      expect(annotations("npcs-get")).toEqual(read);
      expect(annotations("npcs-list")).toEqual(read);
      expect(annotations("npcs-upsert")).toEqual({
        readOnly: false,
        stagesWrites: true,
        idempotent: true,
        concurrencySafe: false,
      });
      expect(annotations("npcs-update")).toEqual({
        readOnly: false,
        stagesWrites: true,
        idempotent: false,
        concurrencySafe: false,
      });
      expect(surface.getToolInfo("npcs-get", context)?.timeoutMs).toBe(
        undefined,
      );
    } finally {
      await toolExecutor.close();
    }
  });

  it("lifts $defs to the tool's root so local references still resolve", () => {
    const placeSchema = {
      $schema: "http://json-schema.org/draft-07/schema#",
      $id: "https://example.com/place.json",
      type: "object",
      $defs: {
        coord: {
          type: "object",
          properties: { x: { type: "number" } },
          required: ["x"],
        },
      },
      properties: {
        name: { type: "string" },
        at: { $ref: "#/$defs/coord" },
      },
      required: ["name"],
    };
    const tools = createDatasetTools(
      agent({
        tools: { datasets: [{ dataset: "places", tools: ["upsert"] }] },
        datasets: {
          places: {
            namespace: "places",
            schema: "./p.json",
            key: "name",
            ops: ["set"],
            tools: ["upsert"],
          },
        },
      }),
      { places: placeSchema },
    );
    const schema = tools.get("places-upsert")!.jsonSchema as Record<
      string,
      unknown
    > & { properties: { record: Record<string, unknown> } };
    expect(schema.$defs).toEqual(placeSchema.$defs);
    expect(schema.properties.record.$defs).toBeUndefined();
    expect(schema.properties.record.$id).toBeUndefined();
    expect(schema.properties.record.$schema).toBeUndefined();
    expect(
      validateOutput({ record: { name: "Harbor", at: { x: 1 } } }, schema)
        .valid,
    ).toBe(true);
    expect(
      validateOutput({ record: { name: "Harbor", at: { x: "far" } } }, schema)
        .valid,
    ).toBe(false);
  });

  it("builds tools for a record schema with conditional keywords", () => {
    const items = JSON.parse(
      readFileSync(
        new URL(
          "../../../plugins/inventory/schemas/items.schema.json",
          import.meta.url,
        ),
        "utf8",
      ),
    ) as Record<string, unknown>;
    const tools = createDatasetTools(
      agent({
        tools: { datasets: [{ dataset: "items", tools: ALL }] },
        datasets: {
          items: {
            namespace: "items",
            schema: "./schemas/items.schema.json",
            key: "id",
            ops: ["set", "merge", "inc"],
            tools: [...ALL],
          },
        },
      }),
      { items },
    );
    expect([...tools.keys()]).toEqual([
      "items-get",
      "items-list",
      "items-upsert",
      "items-update",
    ]);
    const record = (
      tools.get("items-upsert")!.jsonSchema as {
        properties: { record: Record<string, unknown> };
      }
    ).properties.record;
    expect(JSON.stringify(record)).toContain('"if"');
  });
});

describe("dataset tool writes and reads in one run", () => {
  it("stages an upsert under the normalized key and reads it back by any spelling", async () => {
    const { deps, toolExecutor, stored, commit } = await fixture();
    const { llm, requests } = scripted({
      [MARK]: (index) =>
        [
          call("npcs-upsert", { record: { name: "Old  Mara", trust: 10 } }),
          call("npcs-get", { key: "ＯＬＤ ＭＡＲＡ" }),
          call("npcs-list", {}),
          text("Old Mara nods."),
        ][index]!,
    });
    try {
      const execution = await executeTurn(input, [agent()], deps(llm));
      const record = { name: "Old  Mara", trust: 10 };
      const [upserted, got, listed] = toolMessages(requests[3]);
      expect(upserted).toEqual({
        data: { key: "old mara", record, created: true },
        staged: {
          count: 1,
          kinds: ["plugin.data.update"],
          notice: STAGED_NOTICE,
        },
      });
      expect(JSON.stringify(upserted)).not.toContain("success");
      expect(got).toEqual({ data: { key: "old mara", record } });
      expect(listed).toEqual({
        data: { total: 1, items: [{ key: "old mara", record }] },
      });
      expect(JSON.stringify(listed)).not.toContain("updatedAt");
      const result = planned(execution)!;
      expect(proposalsOf(result)).toEqual([
        {
          type: "plugin.data.update",
          payload: {
            namespace: "npcs",
            key: "old mara",
            ops: [{ op: "set", value: record }],
          },
        },
      ]);
      expect((await commit(execution)).status).toBe("committed");
      expect(await stored("npcs", "old mara")).toEqual(record);
    } finally {
      await toolExecutor.close();
    }
  });

  it("refuses an update that leaves the record out of bounds, then commits the value it reported", async () => {
    const { deps, toolExecutor, seed, stored, commit } = await fixture();
    await seed("npcs", "old mara", { name: "Old Mara", trust: 10 });
    const inc = { op: "inc", path: "/trust", by: 95, max: 100 };
    const { llm, requests } = scripted({
      [MARK]: (index) =>
        [
          call("npcs-update", { key: "old mara", ops: [inc] }, "first"),
          call(
            "npcs-update",
            { key: "Old Mara", ops: [{ ...inc, onBound: "clamp" }] },
            "second",
          ),
          text("Mara trusts you."),
        ][index]!,
    });
    try {
      const execution = await executeTurn(input, [agent()], deps(llm));
      const [refused, clamped] = toolMessages(requests[2]) as [
        { error: { code: string; message: string; hint?: string } },
        { data: { key: string; record: unknown } },
      ];
      expect(refused.error).toMatchObject({
        code: "conflict",
        message: expect.stringContaining("Operation 0"),
        hint: "Read the record with npcs-get and adjust.",
      });
      expect(refused.error.message).not.toContain(P);
      expect(clamped.data).toEqual({
        key: "old mara",
        record: { name: "Old Mara", trust: 100 },
      });
      expect(planned(execution)!.pendingProposals).toHaveLength(1);
      expect((await commit(execution)).status).toBe("committed");
      expect(await stored("npcs", "old mara")).toEqual(clamped.data.record);
    } finally {
      await toolExecutor.close();
    }
  });
});

describe("dataset tool errors", () => {
  it("answers a conflict as a failed call, not a refused one, and stages nothing", async () => {
    const { direct, seed, toolExecutor } = await fixture();
    await seed("npcs", "old mara", { name: "Old Mara", trust: 10 });
    try {
      const result = await direct("npcs-update", {
        key: "old mara",
        ops: [{ op: "inc", path: "/trust", by: 95, max: 100 }],
      });
      expect(result.success).toBe(false);
      expect(result.error?.code).toBe("conflict");
      expect(result.refused).toBeUndefined();
      expect(result.pendingProposals ?? []).toEqual([]);
    } finally {
      await toolExecutor.close();
    }
  });

  it("refuses set and undeclared operations, a missing record and a key change", async () => {
    const { direct, seed, toolExecutor } = await fixture();
    await seed("npcs", "old mara", { name: "Old Mara", trust: 10 });
    try {
      for (const op of [
        { op: "set", value: { name: "Old Mara" } },
        { op: "remove", path: "/tags", value: "x" },
      ]) {
        const result = await direct("npcs-update", {
          key: "old mara",
          ops: [op],
        });
        expect(result.error?.code).toBe("invalid-input");
        expect(result.refused).toBeUndefined();
      }
      const missing = await direct("npcs-update", {
        key: "nobody",
        ops: [{ op: "merge", value: { mood: "calm" } }],
      });
      expect(missing.error).toMatchObject({
        code: "not-found",
        hint: "Create it with npcs-upsert.",
      });
      const renamed = await direct("npcs-update", {
        key: "old mara",
        ops: [{ op: "merge", value: { name: "Bram" } }],
      });
      expect(renamed.error).toMatchObject({
        code: "invalid-input",
        message: expect.stringContaining("update cannot change name"),
      });
      expect(renamed.pendingProposals ?? []).toEqual([]);
      // Only the hint of a selected tool is given.
      const without = await direct(
        "npcs-get",
        { key: "nobody" },
        agent({ tools: { datasets: [{ dataset: "npcs", tools: ["get"] }] } }),
      );
      expect(without.error?.code).toBe("not-found");
      expect(without.error?.hint).toBeUndefined();
      const withList = await direct("npcs-get", { key: "nobody" });
      expect(withList.error?.hint).toBe("List records with npcs-list.");
    } finally {
      await toolExecutor.close();
    }
  });

  it("deletes a record with a delete operation", async () => {
    const { direct, seed, toolExecutor } = await fixture();
    await seed("npcs", "old mara", { name: "Old Mara" });
    try {
      const result = await direct("npcs-update", {
        key: "old mara",
        ops: [{ op: "delete" }],
      });
      expect(result.parsedResult).toMatchObject({
        key: "old mara",
        deleted: true,
      });
      expect(proposalsOf(result)).toEqual([
        {
          type: "plugin.data.update",
          payload: {
            namespace: "npcs",
            key: "old mara",
            ops: [{ op: "delete" }],
          },
        },
      ]);
    } finally {
      await toolExecutor.close();
    }
  });

  it("checks the record against the schema and the size limit before staging", async () => {
    const { direct, toolExecutor } = await fixture();
    try {
      const wrong = await direct("npcs-upsert", {
        record: { name: "Mara", trust: "high" },
      });
      expect(wrong.error?.code).toBe("invalid-input");
      expect(wrong.error?.message).toContain("record/trust");
      expect(wrong.error?.message).not.toContain(P);
      expect(wrong.pendingProposals ?? []).toEqual([]);
      const huge = await direct("npcs-upsert", {
        record: { name: "Mara", tags: ["x".repeat(300 * 1024)] },
      });
      expect(huge.error?.code).toBe("invalid-input");
      expect(huge.error?.message).toContain("the limit for one value");
      expect(huge.pendingProposals ?? []).toEqual([]);
      const unnamed = await direct("npcs-upsert", { record: { trust: 3 } });
      expect(unnamed.error?.code).toBe("invalid-input");
      const empty = await direct("npcs-upsert", { record: { name: "   " } });
      expect(empty.error).toMatchObject({
        code: "invalid-input",
        message: expect.stringContaining("key is empty"),
      });
      const long = await direct("npcs-get", { key: "k".repeat(257) });
      expect(long.error?.code).toBe("invalid-input");
    } finally {
      await toolExecutor.close();
    }
  });

  it("answers internal when the record schema cannot be compiled", async () => {
    const { toolExecutor, context } = await fixture();
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const tools = createDatasetTools(agent(), {
        npcs: { type: "object", properties: { name: { $ref: "#/nowhere" } } },
        journal: journalSchema,
      });
      const surface = withAgentToolSurface(
        toolExecutor,
        { available: tools, absent: new Map() },
        undefined,
      );
      const result = await surface.execute(
        {
          toolCallId: "broken",
          name: "npcs-upsert",
          arguments: JSON.stringify({ record: { name: "Mara" } }),
        },
        context,
      );
      expect(result.error).toMatchObject({
        code: "internal",
        message: "The npcs dataset's schema cannot be used.",
      });
      expect(error).toHaveBeenCalled();
    } finally {
      await toolExecutor.close();
    }
  });

  it("answers unavailable without a store", async () => {
    const { direct, toolExecutor } = await fixture({ withStore: false });
    try {
      const result = await direct("npcs-get", { key: "old mara" });
      expect(result.error?.code).toBe("unavailable");
    } finally {
      await toolExecutor.close();
    }
  });
});

describe("dataset keys", () => {
  it("finds a row stored under a non-normalized key and replaces it on upsert", async () => {
    const { direct, seed, toolExecutor } = await fixture();
    await seed("npcs", "Sword_01", { name: "Sword_01", mood: "dull" });
    try {
      const got = await direct("npcs-get", { key: "Sword_01" });
      expect(got.parsedResult).toEqual({
        key: "Sword_01",
        record: { name: "Sword_01", mood: "dull" },
      });
      const replaced = await direct("npcs-upsert", {
        record: { name: "Sword_01", mood: "sharp" },
      });
      expect(replaced.parsedResult).toMatchObject({
        key: "Sword_01",
        created: false,
      });
      expect(proposalsOf(replaced)[0]?.payload).toMatchObject({
        key: "Sword_01",
      });
    } finally {
      await toolExecutor.close();
    }
  });

  it("keys an unkeyed dataset's record by the normalized key argument", async () => {
    const { direct, toolExecutor } = await fixture();
    const manifest = agent({
      tools: { datasets: [{ dataset: "journal", tools: [...ALL] }] },
    });
    try {
      const result = await direct(
        "journal-upsert",
        { key: "Day  One", record: { text: "We set out." } },
        manifest,
      );
      expect(result.parsedResult).toMatchObject({
        key: "day one",
        created: true,
      });
      expect(proposalsOf(result)[0]?.payload).toMatchObject({
        namespace: "journal",
        key: "day one",
      });
    } finally {
      await toolExecutor.close();
    }
  });
});

describe("dataset list", () => {
  it("pages by key and filters on top-level fields", async () => {
    const { direct, seed, toolExecutor } = await fixture();
    for (let i = 25; i >= 1; i--) {
      const name = `npc ${String(i).padStart(2, "0")}`;
      await seed("npcs", name, { name, mood: i % 5 === 0 ? "angry" : "calm" });
    }
    try {
      const first = (await direct("npcs-list", {})).parsedResult as {
        total: number;
        items: { key: string }[];
        nextOffset?: number;
      };
      expect(first.total).toBe(25);
      expect(first.items).toHaveLength(20);
      expect(first.items[0]?.key).toBe("npc 01");
      expect(first.nextOffset).toBe(20);
      const rest = (await direct("npcs-list", { offset: 20 }))
        .parsedResult as typeof first;
      expect(rest.items.map((item) => item.key)).toEqual([
        "npc 21",
        "npc 22",
        "npc 23",
        "npc 24",
        "npc 25",
      ]);
      expect(rest.nextOffset).toBeUndefined();
      const angry = (await direct("npcs-list", { where: { mood: "angry" } }))
        .parsedResult as typeof first;
      expect(angry.total).toBe(5);
      expect(angry.items.map((item) => item.key)).toEqual([
        "npc 05",
        "npc 10",
        "npc 15",
        "npc 20",
        "npc 25",
      ]);
      const tooMany = await direct("npcs-list", { limit: 51 });
      expect(tooMany.error?.code).toBe("invalid-input");
    } finally {
      await toolExecutor.close();
    }
  });

  it("reaches only the calling plugin's own dataset", async () => {
    const { direct, seed, toolExecutor } = await fixture();
    await seed("npcs", "old mara", { name: "Old Mara" }, "other");
    await seed("_hidden", "old mara", { name: "Old Mara" });
    await seed("journal", "old mara", { text: "Old Mara" });
    try {
      const got = await direct("npcs-get", { key: "old mara" });
      expect(got.error?.code).toBe("not-found");
      expect((await direct("npcs-list", {})).parsedResult).toEqual({
        total: 0,
        items: [],
      });
    } finally {
      await toolExecutor.close();
    }
  });
});

describe("dataset tools and the execution", () => {
  it("see an upstream runtime's write, record the read and drop with a rejected producer", async () => {
    const { store, deps, toolExecutor } = await fixture();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const story: RuntimeManifest = {
      name: "narrator/story",
      pluginId: "narrator",
      description: "story",
      runtimeType: "function",
      stage: "narrative",
      outputKind: "story",
      trigger: { type: "auto" },
    };
    const writer = agent({
      name: `${P}/writer`,
      stage: "pre-turn",
      outputKind: "system",
    });
    const reader = agent({
      name: `${P}/reader`,
      stage: "post-turn",
      outputKind: "system",
      tools: { datasets: [{ dataset: "npcs", tools: ["get"] }] },
    });
    const { llm, requests } = scripted({
      [UPSTREAM_MARK]: (index) =>
        [
          call("npcs-upsert", { record: { name: "Old Mara", trust: 1 } }),
          text("Done."),
        ][index]!,
      [MARK]: (index) =>
        [call("npcs-get", { key: "OLD MARA" }), text("Done.")][index]!,
    });
    try {
      const base = deps(llm);
      const execution = await executeTurn(input, [story, writer, reader], {
        ...base,
        loadRuntime: async (manifest: RuntimeManifest) =>
          manifest.name === story.name
            ? {
                manifest,
                promptTemplate: "",
                handler: async () => ({
                  outcome: "success" as const,
                  value: { narrativeOutput: "The story goes on." },
                }),
              }
            : manifest.name === writer.name
              ? {
                  ...(await base.loadRuntime(manifest)),
                  promptTemplate: `${UPSTREAM_MARK} You write.`,
                }
              : base.loadRuntime(manifest),
      });
      const readerRequest = requests.filter((r) => r.mark === MARK)[1];
      expect(toolMessage(readerRequest)).toEqual({
        data: {
          key: "old mara",
          record: { name: "Old Mara", trust: 1 },
        },
      });
      const writerRun = resultOf(execution, writer.name)!.runId;
      const readerRun = resultOf(execution, reader.name)!.runId;
      expect(execution.commit.readDependencies?.[readerRun]).toEqual([
        writerRun,
      ]);
      const outcome = await commitExecution({
        store,
        execution,
        completion: { kind: "turn", turnId: input.turnId, durationMs: 0 },
        proposalGuard: (proposal) =>
          proposal.source.runtimeId === writer.name ? "refused" : undefined,
      });
      expect(outcome.status).toBe("committed");
      expect(
        (outcome.isolatedRuntimes ?? []).map((item) => [
          item.runtimeId,
          item.cause,
        ]),
      ).toEqual([
        [writer.name, "rejected"],
        [reader.name, "read"],
      ]);
    } finally {
      await toolExecutor.close();
    }
  });

  it("offers only the selected tools and refuses a call to another", async () => {
    const { deps, toolExecutor } = await fixture();
    const { llm, requests } = scripted({
      [MARK]: (index) =>
        [call("npcs-upsert", { record: { name: "Mara" } }), text("Nothing.")][
          index
        ]!,
    });
    try {
      const execution = await executeTurn(
        input,
        [
          agent({
            tools: { datasets: [{ dataset: "npcs", tools: ["get"] }] },
          }),
        ],
        deps(llm),
      );
      expect(requests[0]!.tools.map((tool) => tool.name)).toEqual(["npcs-get"]);
      expect(toolMessage(requests[1])).toMatchObject({
        error: {
          code: "unavailable",
          message: expect.stringContaining("not declared"),
        },
      });
      expect(planned(execution)!.pendingProposals ?? []).toEqual([]);
    } finally {
      await toolExecutor.close();
    }
  });

  it("can complete a run", async () => {
    const { deps, toolExecutor } = await fixture();
    const { llm, requests } = scripted({
      [MARK]: () => call("npcs-upsert", { record: { name: "Mara" } }),
    });
    try {
      const execution = await executeTurn(
        input,
        [
          agent({
            outputKind: "system",
            requireToolUse: true,
            completeAfterTools: ["npcs-upsert"],
            llm: { toolChoice: "required" },
          }),
        ],
        deps(llm),
      );
      expect(requests).toHaveLength(1);
      expect(resultOf(execution)).toMatchObject({ status: "success" });
      expect(planned(execution)!.pendingProposals).toHaveLength(1);
    } finally {
      await toolExecutor.close();
    }
  });

  it("are deferred like other tools and found by search-tools", async () => {
    const { deps, toolExecutor } = await fixture();
    const { llm, requests } = scripted({
      [MARK]: (index) =>
        [
          call("search-tools", { query: "npcs upsert record" }),
          call("npcs-upsert", { record: { name: "Mara" } }),
          text("Mara is here."),
        ][index]!,
    });
    try {
      await executeTurn(
        input,
        [
          agent({
            tools: {
              datasets: [{ dataset: "npcs", tools: [...ALL] }],
              defer: true,
            },
          }),
        ],
        deps(llm),
      );
      const names = requests.map((request) =>
        request.tools.map((tool) => tool.name),
      );
      expect(names[0]).toContain("search-tools");
      expect(names[0]).not.toContain("npcs-upsert");
      expect(names[1]).toContain("npcs-upsert");
      expect(toolMessage(requests[2])).toMatchObject({
        data: { key: "mara", created: true },
      });
    } finally {
      await toolExecutor.close();
    }
  });

  it("are offered again to a resumed run", async () => {
    const { deps, store, toolExecutor, commit } = await fixture();
    const manifest = agent({
      outputKind: "system",
      tools: {
        builtin: ["suspend"],
        datasets: [{ dataset: "npcs", tools: [...ALL] }],
      },
    });
    const { llm, requests } = scripted({
      [MARK]: (index) =>
        [
          call("suspend", {
            reason: "Who is it?",
            fields: [{ type: "text", name: "who", label: "Who" }],
          }),
          call("npcs-upsert", { record: { name: "Mara" } }),
          text(JSON.stringify({ done: true })),
        ][index]!,
    });
    try {
      const execution = await executeTurn(input, [manifest], deps(llm));
      expect(resultOf(execution)?.status).toBe("suspended");
      await commit(execution);
      const [suspension] = await store.listSuspensions(SESSION);
      const resumed = await resumeSuspendedRuntime(
        suspension!,
        { who: "Mara" },
        manifest,
        deps(llm),
      );
      expect(resumed.result.status).toBe("success");
      expect(requests[1]!.tools.map((tool) => tool.name)).toEqual(
        expect.arrayContaining(["npcs-upsert", "npcs-get"]),
      );
      expect(toolMessage(requests[2])).toMatchObject({
        data: { key: "mara", created: true },
      });
    } finally {
      await toolExecutor.close();
    }
  });

  it("offer a sub-agent only their reads", async () => {
    const { deps, toolExecutor } = await fixture();
    const helper = agent({
      name: `${P}/helper`,
      outputKind: "system",
      subagentOnly: true,
      trigger: { type: "manual" },
      outputContract: "fixture.helper@1",
      output: { schema: "output.schema.json" },
    });
    const lineSchema = {
      type: "object",
      properties: { line: { type: "string" } },
      required: ["line"],
    };
    const main: RuntimeManifest = {
      name: "other/main",
      pluginId: "other",
      description: "main",
      runtimeType: "function",
      stage: "narrative",
      outputKind: "system",
      trigger: { type: "auto" },
    };
    let answer: unknown;
    const { llm, requests } = scripted({
      [HELPER_MARK]: (index) =>
        index === 0
          ? call("npcs-list", {})
          : text(JSON.stringify({ line: "Nobody yet." })),
    });
    try {
      const base = deps(llm);
      await executeTurn(input, [main, helper], {
        ...base,
        loadRuntime: async (manifest: RuntimeManifest) =>
          manifest.name === helper.name
            ? {
                ...(await base.loadRuntime(manifest)),
                outputSchema: lineSchema,
                outputContractSchema: lineSchema,
              }
            : {
                manifest,
                promptTemplate: "",
                handler: async (ctx) => {
                  answer = await ctx.agents!.run({
                    target: { contract: "fixture.helper@1" },
                    brief: "Who is here?",
                  });
                  return { outcome: "success", value: {} };
                },
              },
      });
      expect(answer).toMatchObject({ ok: true });
      expect(requests[0]!.tools.map((tool) => tool.name).sort()).toEqual([
        "npcs-get",
        "npcs-list",
      ]);
      expect(toolMessage(requests[1])).toEqual({
        data: { total: 0, items: [] },
      });
    } finally {
      await toolExecutor.close();
    }
  });

  it("fail the runtime at start when a dataset's schema is not loaded, and the story still commits", async () => {
    const { deps, toolExecutor, commit } = await fixture();
    const story: RuntimeManifest = {
      name: "narrator/story",
      pluginId: "narrator",
      description: "story",
      runtimeType: "function",
      stage: "narrative",
      outputKind: "story",
      trigger: { type: "auto" },
    };
    const keeper = agent({ stage: "post-turn", outputKind: "system" });
    const { llm, requests } = scripted({ [MARK]: () => text("unused") });
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const base = deps(llm);
      const execution = await executeTurn(input, [story, keeper], {
        ...base,
        loadRuntime: async (manifest: RuntimeManifest) =>
          manifest.name === story.name
            ? {
                manifest,
                promptTemplate: "",
                handler: async () => ({
                  outcome: "success" as const,
                  value: { narrativeOutput: "The story goes on." },
                }),
              }
            : { manifest, promptTemplate: `${MARK} You keep track.` },
      });
      expect(requests).toHaveLength(0);
      const failed = resultOf(execution, keeper.name)!;
      expect(failed.status).toBe("failed");
      expect(failed.error).toContain(
        `runtime "${keeper.name}" uses dataset "npcs", but its declaration or schema is not loaded`,
      );
      expect((await commit(execution)).status).toBe("committed");
    } finally {
      await toolExecutor.close();
    }
  });

  it("does not load the runtime again when it uses no dataset", async () => {
    const loadRuntime = vi.fn();
    const surface = await prepareAgentToolSurface({
      manifest: agent({ tools: { builtin: ["suspend"] } }),
      input,
      deps: { loadRuntime },
    });
    expect(loadRuntime).not.toHaveBeenCalled();
    expect(surface.available.size).toBe(0);
  });
});
