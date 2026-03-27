import { describe, expect, it, vi } from "vitest";

import {
  createMemoryDocument,
  createMessage,
  createSession,
  createWorld
} from "../../../modules/domain/src/index.js";
import { createRuntimeComposition } from "../src/composition.js";

describe("createRuntimeComposition package context assembly", () => {
  it("injects package context fragments into model messages before the user prompt", async () => {
    const runtime = await createRuntimeComposition({
      env: {}
    });
    const generateObject = vi.fn().mockResolvedValue({
      object: {
        content: "context-aware response",
        blocks: []
      },
      finishReason: "stop",
      usage: {
        inputTokens: 10,
        outputTokens: 20
      }
    });

    runtime.modelGateway.generateObject = generateObject;

    await runtime.repositories.worlds.save(createWorld({
      id: "world_ctx_01",
      name: "九州江湖录",
      description: "大梁末年，江湖风云再起。",
      createdAt: new Date("2026-03-26T00:00:00.000Z")
    }));
    await runtime.repositories.sessions.save(createSession({
      id: "session_ctx_01",
      worldId: "world_ctx_01",
      status: "active",
      createdAt: new Date("2026-03-26T00:00:01.000Z")
    }));
    await runtime.repositories.messages.save(createMessage({
      id: "msg_ctx_01",
      sessionId: "session_ctx_01",
      role: "user",
      content: "先看地图",
      createdAt: new Date("2026-03-26T00:00:02.000Z")
    }));
    await runtime.repositories.messages.save(createMessage({
      id: "msg_ctx_02",
      sessionId: "session_ctx_01",
      role: "assistant",
      content: "你看到北城门外的官道和一处渡口。",
      createdAt: new Date("2026-03-26T00:00:03.000Z")
    }));
    await runtime.repositories.memoryDocuments.save(createMemoryDocument({
      id: "mem_ctx_01",
      sourceType: "world",
      scope: "world:world_ctx_01",
      title: "Captain Mire",
      content: [
        "# Captain Mire",
        "Captain Mire 统领着港口巡防。",
        "",
        "## Harbor Watch",
        "港口巡防队只听从 Captain Mire 的命令。"
      ].join("\n"),
      metadata: {},
      provenance: {
        sourceId: "world_ctx_01"
      }
    }));

    await runtime.flowEngine.handle({
      requestId: "req_ctx_01",
      type: "send_message",
      sessionId: "session_ctx_01",
      locale: "zh-CN",
      payload: {
        content: "询问 Captain Mire 的动向"
      }
    });

    const modelInput = generateObject.mock.calls[0]?.[0] as {
      messages: Array<{ role: string; content: string }>;
    };

    expect(modelInput.messages.at(-1)).toEqual({
      role: "user",
      content: "询问 Captain Mire 的动向"
    });
    expect(modelInput.messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: "system",
          content: expect.stringContaining("世界设定")
        }),
        expect.objectContaining({
          role: "system",
          content: expect.stringContaining("九州江湖录")
        }),
        expect.objectContaining({
          role: "system",
          content: expect.stringContaining("世界书摘录")
        }),
        expect.objectContaining({
          role: "system",
          content: expect.stringContaining("叙事人格")
        }),
        expect.objectContaining({
          role: "system",
          content: expect.stringContaining("最近回合记忆")
        }),
        expect.objectContaining({
          role: "system",
          content: expect.stringContaining("玩家: 先看地图")
        }),
        expect.objectContaining({
          role: "system",
          content: expect.stringContaining("角色连续性")
        }),
        expect.objectContaining({
          role: "system",
          content: expect.stringContaining("检索上下文")
        }),
        expect.objectContaining({
          role: "system",
          content: expect.stringContaining("Captain Mire")
        })
      ])
    );
    await expect(runtime.repositories.retrievalRuns.listBySessionId("session_ctx_01")).resolves.toEqual([
      expect.objectContaining({
        id: "retrieval_req_ctx_01",
        query: "询问 Captain Mire 的动向"
      })
    ]);
  });
});
