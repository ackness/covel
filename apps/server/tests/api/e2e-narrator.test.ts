import { DIMENSION_SETTLEMENT_NAMESPACE } from "@covel/shared";
/**
 * E2E test: Complete narrator game flow through the API.
 *
 * Flow:
 *   POST /api/sessions   → create session, activate narrator
 *   POST /api/actions    → execute a player turn (send_message) over the SSE
 *                          stream; we drain it to completion, then read the
 *                          committed store rows for assertions
 *   store assertions     → verify narrative output and turn history
 *
 * `/api/actions` is the single turn-execution entrypoint (the old non-streaming
 * `POST /:id/turn` route was removed); a send_message only schedules the
 * main-loop narrator once the session is in the playing band, so each test
 * settles the current setup mirror first.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import path from "node:path";
import type { Hono } from "hono";
import type { LLMAdapter, LLMResponse } from "@covel/runtime";
import { createMemoryStore } from "@covel/store/memory";
import { bootstrapApi } from "../../src/routes/api/bootstrap.js";
import { closeTestApi } from "../helpers/close-api.js";
import { listRuntimeJobs } from "../../src/routes/api/plugin-rpc/jobs.js";

// ── SSE drain helper ─────────────────────────────────────────────

interface ActionEnvelope {
  readonly type: string;
  readonly requestId: string;
  readonly sessionId: string;
  readonly turnId: string;
  readonly payload: Record<string, unknown>;
}

/** Read an `/api/actions` SSE response to completion, returning its events. */
async function drainActionStream(res: Response): Promise<ActionEnvelope[]> {
  const envelopes: ActionEnvelope[] = [];
  if (!res.body) return envelopes;
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (line.startsWith("data: ")) {
        envelopes.push(JSON.parse(line.slice(6)) as ActionEnvelope);
      }
    }
  }
  return envelopes;
}

// ── Mock LLM that returns narrative text ─────────────────────────

class MockNarratorLLM implements LLMAdapter {
  callCount = 0;
  dimensionUpdates?: readonly {
    id: string;
    expectedVersion: number;
    value: number;
  }[];
  lastMessages: Array<{ role: string; content: string }> = [];
  allMessages: Array<readonly { role: string; content: string }[]> = [];

  async generate(params: {
    messages: readonly { role: string; content: string }[];
    tools?: readonly { name: string }[];
  }): Promise<LLMResponse> {
    this.callCount++;
    this.lastMessages = [...params.messages];
    this.allMessages.push([...params.messages]);

    const updateTool = params.tools?.find(
      (tool) => tool.name.includes("update") && tool.name.includes("dimension"),
    );
    if (updateTool && this.dimensionUpdates)
      return {
        content: null,
        toolCalls: [
          {
            id: crypto.randomUUID(),
            name: updateTool.name,
            arguments: JSON.stringify({ updates: this.dimensionUpdates }),
          },
        ],
        finishReason: "tool_calls",
        usage: { inputTokens: 1, outputTokens: 1 },
      };
    // Find the player message to echo back — use the LAST user turn so
    // seed messages from the turn-band bootstrap don't shadow the current
    // player action.
    const userMsgs = params.messages.filter((m) => m.role === "user");
    const userMsg = userMsgs[userMsgs.length - 1];
    const playerAction = userMsg?.content ?? "未知操作";

    return {
      content: `你${playerAction}。空气中弥漫着潮湿的泥土气息，远处传来隐约的脚步声。你紧握手中的武器，警惕地环顾四周。一道微弱的光芒从前方的裂缝中透出，似乎在引导你前行。`,
      toolCalls: [],
      finishReason: "stop",
      usage: { inputTokens: 200, outputTokens: 80 },
    };
  }
}

// ── Tests ─────────────────────────────────────────────────────────

describe("E2E: Narrator game flow", () => {
  let boot: Awaited<ReturnType<typeof bootstrapApi>>;
  let app: Hono;
  let mockLLM: MockNarratorLLM;
  let store: Awaited<ReturnType<typeof bootstrapApi>>["store"];

  const PLUGINS_DIR = path.resolve(import.meta.dirname, "../../../../plugins");

  beforeAll(async () => {
    mockLLM = new MockNarratorLLM();
    const result = (boot = await bootstrapApi({
      pluginsDir: PLUGINS_DIR,
      llmAdapter: mockLLM,
      canRunRuntimeJobWithServerServices: () => true,
      pluginGateway: {
        async generateText() {
          return { text: "{}", finishReason: "stop", usage: {} };
        },
      } as import("@covel/shared/plugin-runtime").PluginRuntimeGateway,
      store: createMemoryStore(),
      storeBackend: "memory",
    }));
    app = result.app;
    store = result.store;

    // Activate narrator for all sessions globally
    result.registry.syncSessionActivations("__global__", ["narrator"]);
  });

  afterAll(async () => {
    await closeTestApi(boot);
    await store?.close();
  });

  async function markPreGameComplete(sessionId: string) {
    const session = await store.getSession(sessionId);
    if (!session) throw new Error("expected session");
    const now = new Date().toISOString();
    await store.upsertCharacterSchema({
      sessionId,
      version: 1,
      types: ["npc", "companion"],
      attributes: [],
      createdAt: now,
      updatedAt: now,
    });
    const setupRuntimes = Object.fromEntries(
      Object.entries(session.setupRuntimes).map(([runtimeId, state]) => [
        runtimeId,
        {
          state: "done" as const,
          resolution: "completed" as const,
          generation: state.generation,
          attempts: Math.max(1, state.attempts),
          completedAt: now,
          pluginVersion: state.pluginVersion,
        },
      ]),
    );
    await store.updateSession(sessionId, {
      phase: "playing",
      completedPlayerTurns: 0,
      setupRuntimes,
      updatedAt: now,
    });
  }

  it("should complete a full game turn through the API", async () => {
    // 1. Create session
    const startRes = await app.request("/api/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ locale: "zh-CN", plugins: ["narrator"] }),
    });
    expect(startRes.status).toBe(201);

    const session = (await startRes.json()) as {
      id: string;
      status: string;
      phase: "setup" | "playing";
      completedPlayerTurns: number;
    };
    expect(session.id).toBeDefined();
    expect(session.status).toBe("active");
    expect(session.completedPlayerTurns).toBe(0);

    const sessionId = session.id;

    await markPreGameComplete(sessionId);

    // 2. Execute a turn over /api/actions (drain the SSE stream to completion).
    const turnRes = await app.request("/api/actions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        requestId: "req-narrator-1",
        type: "send_message",
        sessionId,
        locale: "zh-CN",
        payload: { content: "走进了黑暗的森林" },
      }),
    });
    expect(turnRes.status).toBe(200);

    const events = await drainActionStream(turnRes);
    expect(events.map((e) => e.type)).not.toContain("error.occurred");
    const turnId = events.find((e) => e.type === "execution.started")?.turnId;
    expect(turnId).toBeDefined();

    // The committed rows are the source of truth (the route no longer returns a
    // turn-result body). Narrator runtime succeeded for this turn:
    const runtimeRows = await store.listRuntimeResults(sessionId, turnId!);
    const narratorRow = runtimeRows.find((r) => r.runtimeId === "narrator");
    expect(narratorRow).toBeDefined();
    expect(narratorRow!.status).toBe("success");

    // …and its narrative landed in the messages table:
    const messages = await store.listTurnMessages(sessionId);
    const narratorNarrative = messages
      .filter((m) => m.sourceRuntimeId === "narrator")
      .at(-1);
    expect(narratorNarrative?.content).toContain("走进了黑暗的森林");
    expect(narratorNarrative?.content).toContain("泥土气息");

    // 3. Verify LLM was called with correct context
    expect(mockLLM.callCount).toBeGreaterThanOrEqual(1);
    const narratorMessages = mockLLM.allMessages.find((messages) =>
      messages.some((m) => m.role === "system" && m.content.includes("叙述者")),
    );
    const systemMsg = narratorMessages?.find((m) => m.role === "system");
    expect(systemMsg).toBeDefined();
    // System prompt carries the PLUGIN.md template; the player message rides
    // the user role exclusively and must NOT be interpolated into it.
    expect(systemMsg!.content).toContain("叙述者");
    expect(systemMsg!.content).not.toContain("走进了黑暗的森林");
    const userMsgs = narratorMessages?.filter((m) => m.role === "user") ?? [];
    expect(userMsgs.at(-1)?.content).toContain("走进了黑暗的森林");
  });

  it("should handle multiple turns in sequence", async () => {
    // Create session
    const startRes = await app.request("/api/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ plugins: ["narrator"] }),
    });
    const session = (await startRes.json()) as { id: string };

    await markPreGameComplete(session.id);

    // Turn 1
    const turn1Res = await app.request("/api/actions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        requestId: "req-multi-1",
        type: "send_message",
        sessionId: session.id,
        locale: "zh-CN",
        payload: { content: "拔出长剑" },
      }),
    });
    expect(turn1Res.status).toBe(200);
    expect(
      (await drainActionStream(turn1Res)).map((e) => e.type),
    ).not.toContain("error.occurred");

    // Turn 2
    const turn2Res = await app.request("/api/actions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        requestId: "req-multi-2",
        type: "send_message",
        sessionId: session.id,
        locale: "zh-CN",
        payload: { content: "向巨龙发起攻击" },
      }),
    });
    expect(turn2Res.status).toBe(200);
    expect(
      (await drainActionStream(turn2Res)).map((e) => e.type),
    ).not.toContain("error.occurred");
    await vi.waitFor(async () => {
      const jobs = await listRuntimeJobs(store, { sessionId: session.id });
      expect(
        jobs.filter((job) => job.runtimeId === "memory/extract"),
      ).toHaveLength(2);
      expect(jobs.every((job) => job.status === "succeeded")).toBe(true);
    });
  });

  it("should return 404 for a turn on a non-existent session", async () => {
    const res = await app.request("/api/actions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        requestId: "req-missing",
        type: "send_message",
        sessionId: "nonexistent",
        locale: "zh-CN",
        payload: { content: "test" },
      }),
    });
    expect(res.status).toBe(404);
  });

  it("should list narrator in plugins", async () => {
    const res = await app.request("/api/plugins");
    expect(res.status).toBe(200);

    const body = (await res.json()) as {
      items: Array<{ id: string; kind: string }>;
    };
    const narrator = body.items.find((p) => p.id === "narrator");
    expect(narrator).toBeDefined();
    expect(narrator!.kind).toBe("core");
  });

  it("should health check", async () => {
    const res = await app.request("/api/health");
    expect(res.status).toBe(200);

    const body = (await res.json()) as { status: string };
    expect(body.status).toBe("ok");
  });
  it("recovers one original dimension source through real RPC without advancing or settling twice", async () => {
    const created = await (
      await app.request("/api/sessions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ locale: "zh-CN", plugins: ["narrator"] }),
      })
    ).json();
    const id = created.id as string;
    await markPreGameComplete(id);
    const now = new Date().toISOString();
    const definition = {
      name: "Study",
      schema: { type: "integer", minimum: 0 },
      initialValue: 0,
      updateRule: "明确完成学习后加一；没有完成则不变。",
    };
    await store.setPluginData({
      id: crypto.randomUUID(),
      createdAt: now,
      sessionId: id,
      pluginId: "world-init",
      namespace: "_dimensions",
      key: "study",
      value: { definition, value: 0, version: 1 },
      updatedAt: now,
    });
    await store.updateSession(id, {
      metadata: { _dimensionProviderPluginId: "world-init" },
    });
    const send = async (requestId: string) =>
      drainActionStream(
        await app.request("/api/actions", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            requestId,
            type: "send_message",
            sessionId: id,
            payload: { content: "完成学习" },
          }),
        }),
      );
    const events = await send("dimension-source");
    const receiptRow = (
      await store.listPluginData(
        id,
        "world-init",
        DIMENSION_SETTLEMENT_NAMESPACE,
      )
    )[0]!;
    const receipt = receiptRow.value as {
      source: { resultId: string };
      sourceTurnId: string;
      status: string;
    };
    expect(receipt.status).toBe("pending-settlement");
    expect(
      events.some((event) => event.type === "dimensions.settlement.changed"),
    ).toBe(true);
    expect((await store.getSession(id))?.completedPlayerTurns).toBe(1);
    await send("dimension-barrier");
    expect((await store.getSession(id))?.completedPlayerTurns).toBe(1);
    const rpc = (payload: unknown, retry = false) =>
      app.request(`/api/sessions/${id}/plugin-rpc`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          kind: "runtime",
          pluginId: "world-init",
          runtimeId: retry
            ? "world-init/dimension-tracker"
            : "world-init/edit-dimensions",
          payload: retry ? {} : payload,
          ...(retry ? { retryFromTurnId: receipt.sourceTurnId } : {}),
        }),
      });
    mockLLM.dimensionUpdates = [{ id: "study", expectedVersion: 1, value: 1 }];
    try {
      const original = (await store.listTurnResults(id)).find(
        (row) => row.turnId === receipt.sourceTurnId,
      )!;
      expect(
        original.runtimeResults.some(
          (result) => result.runId === receipt.source.resultId,
        ),
        JSON.stringify(original.runtimeResults),
      ).toBe(true);
      const response = await rpc(
        { updates: [], resultId: receipt.source.resultId, resolution: "retry" },
        true,
      );
      expect(
        response.status,
        JSON.stringify(await response.clone().json()),
      ).toBe(200);
      expect(
        (await store.getPluginData(id, "world-init", "_dimensions", "study"))
          ?.value,
        JSON.stringify({
          response: await response.clone().json(),
          receipt: await store.getPluginData(
            id,
            "world-init",
            DIMENSION_SETTLEMENT_NAMESPACE,
            receipt.source.resultId,
          ),
        }),
      ).toMatchObject({ value: 1, version: 2 });
      expect(
        (
          await store.getPluginData(
            id,
            "world-init",
            DIMENSION_SETTLEMENT_NAMESPACE,
            receipt.source.resultId,
          )
        )?.value,
      ).toMatchObject({ status: "settled", source: receipt.source });
      expect((await store.getSession(id))?.completedPlayerTurns).toBe(1);
      expect(
        (
          await rpc(
            {
              updates: [],
              resultId: receipt.source.resultId,
              resolution: "retry",
            },
            true,
          )
        ).status,
      ).toBe(200);
      expect(
        (await store.getPluginData(id, "world-init", "_dimensions", "study"))
          ?.value,
      ).toMatchObject({ value: 1, version: 2 });
      const conflict = await (
        await rpc({ updates: [{ id: "study", expectedVersion: 1, value: 9 }] })
      ).json();
      expect(conflict.runtimeResults[0].output).toMatchObject({
        applied: false,
        code: "dimension-version-conflict",
        currentVersions: { study: 2 },
      });
      const view = await (await app.request(`/api/sessions/${id}/view`)).json();
      expect(view.dimensionRecovery).toEqual({
        editorRuntimeId: "world-init/edit-dimensions",
        trackerRuntimeId: "world-init/dimension-tracker",
      });
      expect(view.dimensions.study).toMatchObject({ value: 1, version: 2 });
      expect(view.dimensions.study).not.toHaveProperty("initialValue");
      expect(view.dimensions.study).not.toHaveProperty("updateRule");
    } finally {
      mockLLM.dimensionUpdates = undefined;
    }
  });
});
