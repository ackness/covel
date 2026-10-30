/**
 * A player's submitted actions come back on their message through /view (the
 * restore path) and /messages, so a restored chat can say who acted and how.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import path from "node:path";
import type { Hono } from "hono";
import type { LLMAdapter, LLMResponse } from "@covel/runtime";
import { createMemoryStore } from "@covel/store/memory";
import { bootstrapApi } from "../../src/routes/api/bootstrap.js";
import { closeTestApi } from "../helpers/close-api.js";

const PLUGINS_DIR = path.resolve(import.meta.dirname, "../../../../plugins");
const AYA_ID = "char-aya-7f3a";
const BO_ID = "char-bo-91c2";

class QuietNarrator implements LLMAdapter {
  async generate(): Promise<LLMResponse> {
    return {
      content: JSON.stringify({
        segments: [{ kind: "narration", text: "雨停了。" }],
      }),
      toolCalls: [],
      finishReason: "stop",
      usage: { inputTokens: 10, outputTokens: 10 },
    };
  }
}

async function drain(res: Response): Promise<void> {
  const reader = res.body?.getReader();
  if (!reader) return;
  while (!(await reader.read()).done);
}

interface Row {
  role: string;
  content: string;
  actions?: {
    kind: string;
    text?: string;
    seatId: string;
    actorId?: string;
    source: string;
  }[];
}

describe("player actions on restored messages", () => {
  let boot: Awaited<ReturnType<typeof bootstrapApi>>;
  let app: Hono;
  let sessionId: string;
  let seatId: string;

  const turn = async (requestId: string, kind: string, words: string) => {
    const res = await app.request("/api/actions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        requestId,
        type: "submit_actions",
        sessionId,
        payload: { actions: [{ kind, text: words }] },
      }),
    });
    expect(res.status).toBe(200);
    await drain(res);
  };

  const viewUserRows = async (): Promise<Row[]> => {
    const view = (await (
      await app.request(`/api/sessions/${sessionId}/view`)
    ).json()) as { messages: Row[] };
    return view.messages.filter((message) => message.role === "user");
  };

  beforeAll(async () => {
    boot = await bootstrapApi({
      pluginsDir: PLUGINS_DIR,
      llmAdapter: new QuietNarrator(),
      store: createMemoryStore(),
      storeBackend: "memory",
    });
    app = boot.app;
    boot.registry.syncSessionActivations("__global__", ["narrator"]);
    const created = await app.request("/api/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        locale: "zh-CN",
        plugins: ["narrator"],
        excludedPlugins: [...boot.registry.getAll().keys()].filter(
          (pluginId) => pluginId !== "narrator",
        ),
      }),
    });
    expect(created.status).toBe(201);
    sessionId = ((await created.json()) as { id: string }).id;
    const session = (await boot.store.getSession(sessionId))!;
    seatId = session.seats.find((seat) => seat.role === "player")!.id;
    const now = new Date().toISOString();
    await boot.store.upsertCharacterSchema({
      sessionId,
      version: 1,
      types: ["player"],
      attributes: [],
      createdAt: now,
      updatedAt: now,
    });
    for (const [id, name] of [
      [AYA_ID, "阿雅"],
      [BO_ID, "阿波"],
    ] as const)
      await boot.store.upsertCharacter({
        id,
        sessionId,
        name,
        type: "player",
        version: 1,
        createdAt: now,
        updatedAt: now,
      });
    await boot.store.updateSession(sessionId, {
      phase: "playing",
      completedPlayerTurns: 0,
      setupRuntimes: Object.fromEntries(
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
      ),
      updatedAt: now,
    });
  });

  afterAll(async () => {
    await closeTestApi(boot);
    await boot.store.close();
  });

  it("returns the resolved actions of a submitted act on /view", async () => {
    await turn("req-act-1", "act", "拔出剑");
    const [row] = await viewUserRows();
    expect(row?.content).toBe("拔出剑");
    expect(row?.actions).toEqual([
      {
        seatId,
        kind: "act",
        actorId: AYA_ID,
        text: "拔出剑",
        source: "player",
      },
    ]);
  });

  it("attributes the next say to the character the seat was switched to", async () => {
    const switched = await app.request(
      `/api/sessions/${sessionId}/seats/${seatId}`,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ currentCharacterId: BO_ID }),
      },
    );
    expect(switched.status).toBe(200);
    await turn("req-say-2", "say", "我来了");
    const rows = await viewUserRows();
    expect(rows.at(-1)?.actions?.[0]).toMatchObject({
      kind: "say",
      actorId: BO_ID,
    });
    // The earlier message keeps the character that acted then.
    expect(rows[0]?.actions?.[0]?.actorId).toBe(AYA_ID);
  });

  it("returns the same actions on /messages", async () => {
    const { items } = (await (
      await app.request(`/api/sessions/${sessionId}/messages`)
    ).json()) as { items: Row[] };
    const users = items.filter((message) => message.role === "user");
    expect(users.map((row) => row.actions?.[0]?.kind)).toEqual(["act", "say"]);
  });
});
