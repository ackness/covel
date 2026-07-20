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
 * main-loop narrator once the session is out of the Pre-Game band, so each test
 * advances `turnCount`/`preGameCompleted` first.
 */

import { describe, it, expect, beforeAll } from "vitest";
import path from "node:path";
import type { Hono } from "hono";
import type { LLMAdapter, LLMResponse } from "@covel/runtime";
import { createMemoryStore } from "@covel/store";
import { bootstrapApi } from "../../src/routes/api/bootstrap.js";

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
  lastMessages: Array<{ role: string; content: string }> = [];
  allMessages: Array<readonly { role: string; content: string }[]> = [];

  async generate(params: {
    messages: readonly { role: string; content: string }[];
  }): Promise<LLMResponse> {
    this.callCount++;
    this.lastMessages = [...params.messages];
    this.allMessages.push([...params.messages]);

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
  let app: Hono;
  let mockLLM: MockNarratorLLM;
  let store: Awaited<ReturnType<typeof bootstrapApi>>["store"];

  const PLUGINS_DIR = path.resolve(import.meta.dirname, "../../../../plugins");

  beforeAll(async () => {
    mockLLM = new MockNarratorLLM();
    const result = await bootstrapApi({
      pluginsDir: PLUGINS_DIR,
      llmAdapter: mockLLM,
      store: createMemoryStore(),
      storeBackend: "memory",
    });
    app = result.app;
    store = result.store;

    // Activate narrator for all sessions globally
    result.registry.activate("narrator", "__global__");
  });

  async function markPreGameComplete(sessionId: string) {
    await store.updateSession(sessionId, {
      preGameCompleted: [
        "pregame",
        "world-init/schema-gen",
        "char-creator/player-init",
      ],
      turnCount: 1,
      updatedAt: new Date().toISOString(),
    });
  }

  it("should complete a full game turn through the API", async () => {
    // 1. Create session
    const startRes = await app.request("/api/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ locale: "zh-CN", plugins: ["narrator"] }),
    });
    expect(startRes.status).toBe(200);

    const session = (await startRes.json()) as {
      id: string;
      status: string;
      turnCount: number;
    };
    expect(session.id).toBeDefined();
    expect(session.status).toBe("active");
    expect(session.turnCount).toBe(0);

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
      plugins: Array<{ id: string; pluginType: string }>;
    };
    const narrator = body.plugins.find((p) => p.id === "narrator");
    expect(narrator).toBeDefined();
    expect(narrator!.pluginType).toBe("core-plugin");
  });

  it("should health check", async () => {
    const res = await app.request("/api/health");
    expect(res.status).toBe(200);

    const body = (await res.json()) as { status: string };
    expect(body.status).toBe("ok");
  });
});
