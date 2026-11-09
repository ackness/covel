import { completedBusinessOutput } from "../helpers/output-submission.js";
import { submittedOutput } from "../helpers/output-submission.js";
import { cp, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createSqliteStore } from "@covel/store/sqlite";
import type {
  LLMAdapter,
  LLMMessage,
  LLMResponse,
  RuntimeResult,
} from "@covel/shared";
import {
  bootstrapApi,
  type ApiBootstrapResult,
} from "../../src/routes/api/bootstrap.js";
import { resolveSessionPluginPlan } from "../../src/routes/api/session/plugins.js";
import { closeTestApi } from "../helpers/close-api.js";
import { runtimeResultsOf } from "../helpers/runtime-results.js";

/**
 * The five plugins that read the shared world facts (`world-ir@2`) take them
 * as an optional input. With the extractor installed but not selected, the
 * session resolves without it, and each consumer still loads and runs: the
 * agents read this turn's story directly, and the function ledgers skip.
 */
const project = path.resolve(import.meta.dirname, "../../../..");
const sessionId = "world-ir-optional";
const consumers = [
  "inventory",
  "affinity",
  "codex",
  "core-quest",
  "npc-graph",
] as const;
const client = vi.hoisted(() => ({ address: "" }));
vi.mock("@hono/node-server/conninfo", () => ({
  getConnInfo: () => ({ remote: { address: client.address } }),
}));
const headers = {
  Authorization: "Bearer synthetic-world-ir-token",
  "Content-Type": "application/json",
};
const story =
  "Ren helps Mara the ferrywoman mend her torn net on the quay of Saltglass Harbor. Mara thanks Ren warmly and promises a free crossing.";
const textOf = (message: LLMMessage) =>
  typeof message.content === "string"
    ? message.content
    : message.content
        .map((part) => (part.type === "text" ? part.text : ""))
        .join("");
const call = (name: string, args: unknown): LLMResponse => ({
  content: null,
  toolCalls: [{ id: `call-${name}`, name, arguments: JSON.stringify(args) }],
  finishReason: "tool_calls",
  usage: { inputTokens: 1, outputTokens: 1 },
});
/** Each agent's one business call, keyed by the tool that identifies it. */
const businessCalls: Record<string, unknown> = {
  "update-affinity": {
    changes: [{ name: "Mara", delta: 3, reason: "You mended her net" }],
  },
  "sync-codex-entries": {
    entries: [
      {
        title: "Saltglass Harbor",
        category: "location",
        content: "A busy harbor where ferries cross the bay.",
      },
    ],
  },
  "upsert-npc-graph": {
    nodes: [
      { name: "Ren", type: "individual", summary: "The player." },
      {
        name: "Mara",
        type: "individual",
        summary: "A ferrywoman at Saltglass Harbor.",
      },
    ],
    edges: [
      {
        sourceName: "Mara",
        targetName: "Ren",
        relation: "TRUSTS",
        strength: 0.3,
        fact: "Mara trusts Ren after Ren helped her mend her net.",
      },
    ],
  },
};

describe("world-ir consumers without the extractor", () => {
  let root: string;
  let boot: ApiBootstrapResult | undefined;
  let store: ReturnType<typeof createSqliteStore>;
  let active: readonly string[];
  let results: readonly RuntimeResult[];
  const requests = new Map<string, Parameters<LLMAdapter["generate"]>[0][]>();
  const generate: LLMAdapter["generate"] = async (request) => {
    const names = request.tools?.map(({ name }) => name) ?? [];
    const runtime = names.includes("submit-world-facts")
      ? "world-ir"
      : (Object.keys(businessCalls).find((name) => names.includes(name)) ??
        "narrator");
    requests.set(runtime, [...(requests.get(runtime) ?? []), request]);
    if (runtime === "narrator")
      return submittedOutput({
        segments: [{ kind: "narration", text: story }],
        cues: { present: ["Ren", "Mara"] },
      });
    if (runtime === "world-ir") throw new Error("world-ir must not run");
    return completedBusinessOutput(request.messages, runtime)
      ? submittedOutput({})
      : call(runtime, businessCalls[runtime]);
  };

  beforeAll(async () => {
    client.address = crypto.randomUUID();
    root = await mkdtemp(path.join(tmpdir(), "world-ir-optional-"));
    const builtin = path.join(root, "builtin");
    const user = path.join(root, "user");
    await mkdir(user);
    await mkdir(builtin);
    // The extractor is installed; only the session selection leaves it out.
    for (const id of ["narrator", "world-ir", ...consumers]) {
      await cp(path.join(project, "plugins", id), path.join(builtin, id), {
        recursive: true,
        filter: (source) => !source.includes("node_modules"),
      });
    }
    vi.stubEnv("COVEL_USER_PLUGINS_DIR", user);
    vi.stubEnv("COVEL_DESKTOP_REST_TOKEN", "synthetic-world-ir-token");
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("COVEL_INSTRUCTION_LOCALE", "en");
    store = createSqliteStore(path.join(root, "session.sqlite"));
    boot = await bootstrapApi({
      pluginsDir: builtin,
      pluginsDirs: [builtin, user],
      store,
      storeBackend: "sqlite",
      llmAdapter: { generate },
    });
    const plan = resolveSessionPluginPlan(
      ["narrator", ...consumers],
      boot.registry,
    );
    expect(plan.rejected).toEqual([]);
    active = plan.active;
    const now = new Date().toISOString();
    await store.createSession({
      id: sessionId,
      status: "active",
      phase: "playing",
      setupRuntimes: {},
      seats: [
        { id: "main", controller: "human", role: "player", characters: "auto" },
      ],
      completedPlayerTurns: 0,
      activePlugins: [...active],
      locale: "en-US",
      metadata: {
        approvalScopeNonce: crypto.randomUUID(),
        sessionIncarnationNonce: crypto.randomUUID(),
      },
      createdAt: now,
      updatedAt: now,
    });
    await store.upsertCharacterSchema({
      sessionId,
      version: 1,
      types: ["npc", "companion"],
      attributes: [],
      createdAt: now,
      updatedAt: now,
    });
    await store.upsertCharacter({
      id: "player-ren",
      sessionId,
      name: "Ren",
      type: "player",
      version: 1,
      createdAt: now,
      updatedAt: now,
    });
    const response = await boot.app.request("/api/actions", {
      method: "POST",
      headers,
      body: JSON.stringify({
        requestId: crypto.randomUUID(),
        sessionId,
        type: "submit_actions",
        payload: { actions: [{ kind: "say", text: "Help Mara mend her net." }] },
      }),
    });
    const body = await response.text();
    expect(response.status, body).toBe(200);
    const row = (await store.listTurnResults(sessionId)).at(-1)!;
    expect(row.commitStatus, body).toBe("committed");
    results = runtimeResultsOf(row);
  });
  afterAll(async () => {
    await closeTestApi(boot);
    boot = undefined;
    await store?.close();
    if (root) await rm(root, { recursive: true, force: true });
    vi.unstubAllEnvs();
  });

  const resultOf = (runtimeId: string) =>
    results.find((result) => result.runtimeId === runtimeId);
  const data = async (pluginId: string, namespace: string) =>
    (await store.listPluginData(sessionId, pluginId, namespace)).map(
      ({ value }) => value as Record<string, unknown>,
    );
  /** The agent read the story itself, with no world facts bound. */
  const expectStoryWithoutFacts = (runtime: string) => {
    const [request] = requests.get(runtime) ?? [];
    expect(request, runtime).toBeDefined();
    const text = request!.messages.map(textOf).join("\n");
    expect(text).toContain("Saltglass Harbor");
    for (const block of text.match(
      /<runtime-inputs>[\s\S]*?<\/runtime-inputs>/g,
    ) ?? [])
      expect(block).not.toContain("worldIR");
  };

  it("resolves the session without the extractor and never runs it", () => {
    expect(active).toEqual(expect.arrayContaining([...consumers]));
    expect(active).not.toContain("world-ir");
    expect(requests.has("world-ir")).toBe(false);
    expect(results.some(({ pluginId }) => pluginId === "world-ir")).toBe(false);
    expect(
      results
        .filter(({ status }) => status === "failed")
        .map(({ runtimeId }) => runtimeId),
    ).toEqual([]);
  });

  it("inventory skips its ledger and keeps the bag", async () => {
    expect(resultOf("inventory/ledger")?.status).toBe("skipped");
    expect(resultOf("inventory/vocabulary")?.status).toBe("success");
    expect(await data("inventory", "items")).toEqual([]);
  });

  it("core-quest skips its log and keeps the quests", async () => {
    expect(resultOf("core-quest/log")?.status).toBe("skipped");
    expect(resultOf("core-quest/vocabulary")?.status).toBe("success");
    expect(await data("core-quest", "quests")).toEqual([]);
  });

  it("affinity reads the story and records the change", async () => {
    expect(resultOf("affinity")?.status).toBe("success");
    expectStoryWithoutFacts("update-affinity");
    expect(await data("affinity", "affinity")).toEqual([
      expect.objectContaining({ name: "Mara", score: 3 }),
    ]);
  });

  it("codex reads the story and records the discovery", async () => {
    expect(resultOf("codex")?.status).toBe("success");
    expectStoryWithoutFacts("sync-codex-entries");
    expect(await data("codex", "entries")).toEqual([
      expect.objectContaining({ title: "Saltglass Harbor" }),
    ]);
  });

  it("npc-graph reads the story and records the relationship", async () => {
    expect(resultOf("npc-graph/extractor")?.status).toBe("success");
    expectStoryWithoutFacts("upsert-npc-graph");
    expect(
      (await data("npc-graph", "nodes")).map(({ name }) => name).sort(),
    ).toEqual(["Mara", "Ren"]);
  });
});
