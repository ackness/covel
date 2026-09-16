import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { discoverPlugins, loadRuntime } from "@covel/plugin-loader";
import { createMemoryStore } from "@covel/store";
import { createCharacterTools } from "@covel/tools";
import { executeTurn } from "../src/turn-executor/turn-executor.js";
import { createToolExecutor } from "../src/agent-loop/tool-executor.js";
import type { LLMAdapter } from "../src/llm/llm-adapter.js";

const plugins = path.resolve(import.meta.dirname, "../../../plugins");

describe.each(["narrator", "chat-mode-narrator"])(
  "%s character profiles",
  (id) => {
    it("reads a never-seen NPC's full profile through governed tools without write access", async () => {
      const discovery = (await discoverPlugins(plugins)).find(
        (entry) => entry.id === id,
      )!;
      const loaded = await loadRuntime(discovery, id);
      const store = createMemoryStore();
      const now = new Date().toISOString();
      for (const sessionId of ["story", "other"]) {
        await store.createSession({
          id: sessionId,
          worldId: null,
          phase: "playing",
          status: "active",
          completedPlayerTurns: 1,
          activePlugins: [id],
          setupRuntimes: {},
          createdAt: now,
          updatedAt: now,
        });
        await store.upsertCharacter({
          id: `${sessionId}-npc`,
          sessionId,
          name: "椎名夏帆",
          type: "npc",
          description:
            sessionId === "story" ? "轻音部吉他手" : "PRIVATE OTHER SESSION",
          fields: { class: "二年 A 组", club: "轻音部" },
          version: 1,
          createdAt: now,
          updatedAt: now,
        });
      }
      const tools = createCharacterTools(store);
      const generate = vi.fn<LLMAdapter["generate"]>(async (request) => {
        const names = request.tools?.map((tool) => tool.name) ?? [];
        expect(names).toEqual(
          expect.arrayContaining(["list-characters", "get-character"]),
        );
        expect(names).not.toEqual(expect.arrayContaining(["create-character"]));
        expect(names).not.toContain("update-character");
        const results = request.messages.filter(
          (message) => message.role === "tool",
        );
        if (!results.length)
          return {
            content: "",
            toolCalls: [
              {
                id: "read-profile",
                name: "get-character",
                arguments: JSON.stringify({ name: "椎名夏帆" }),
              },
            ],
            finishReason: "tool_calls",
            usage: { inputTokens: 1, outputTokens: 1 },
          };
        const text = JSON.stringify(results);
        expect(text).toContain("二年 A 组");
        expect(text).toContain("吉他手");
        expect(text).not.toContain("PRIVATE OTHER SESSION");
        return {
          content: "夏帆是二年 A 组的吉他手。",
          toolCalls: [],
          finishReason: "stop",
          usage: { inputTokens: 1, outputTokens: 1 },
        };
      });
      const result = await executeTurn(
        {
          sessionId: "story",
          turnId: "turn",
          origin: "player",
          playerMessage: "夏帆是几年级，负责什么？",
        },
        [loaded.manifest],
        {
          store,
          loadRuntime: async () => loaded,
          llm: { generate },
          toolExecutor: createToolExecutor({
            findTool: (name) => tools.find((tool) => tool.name === name),
            getToolSource: () => "builtin",
          }),
        },
      );
      expect(result.runtimeResults[0]?.status).toBe("success");
      expect(
        result.runtimeResults[0]?.toolCalls.map((call) => call.toolName),
      ).toContain("get-character");
      expect(generate).toHaveBeenCalledTimes(2);
      expect((await store.listCharacters("story"))[0]?.version).toBe(1);
    });
  },
);
