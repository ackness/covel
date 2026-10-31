import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createMemoryStore } from "@covel/store/memory";
import type { LLMAdapter, LLMResponse } from "@covel/shared";
import {
  bootstrapApi,
  type ApiBootstrapResult,
} from "../../src/routes/api/bootstrap.js";
import { closeTestApi } from "../helpers/close-api.js";

const reply = (value: unknown): LLMResponse => ({
  content: JSON.stringify(value),
  toolCalls: [],
  finishReason: "stop",
  usage: { inputTokens: 1, outputTokens: 1 },
});
const call = (name: string, args: unknown, id: string): LLMResponse => ({
  content: null,
  toolCalls: [{ name, arguments: JSON.stringify(args), id }],
  finishReason: "tool_calls",
  usage: { inputTokens: 1, outputTokens: 1 },
});
afterEach(() => vi.unstubAllEnvs());

describe("community character orchestration through the public API", () => {
  it("approves the documented package, selects a policy and commits one story despite a failed actor without leaking private traces", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "orchestration-api-"));
    const builtin = path.join(root, "builtin");
    const user = path.join(root, "user");
    const store = createMemoryStore();
    let boot: ApiBootstrapResult | undefined;
    try {
      await mkdir(builtin);
      const guide = await readFile(
        path.resolve(
          import.meta.dirname,
          "../../../../docs/en/plugins/advanced.md",
        ),
        "utf8",
      );
      const block = (name: string) => {
        const found = guide.match(
          new RegExp(
            `<!-- orchestration-${name} -->\\s*\x60\x60\x60(?:yaml|js)\\n([\\s\\S]*?)\\n\x60\x60\x60`,
          ),
        );
        if (!found?.[1]) throw new Error(`Missing guide example ${name}`);
        return found[1];
      };
      for (const [name, file] of Object.entries({
        package: "PLUGIN.md",
        entry: "server/index.js",
        actor: "runtimes/actor/RUNTIME.md",
        agent: "runtimes/story/RUNTIME.md",
      })) {
        const target = path.join(user, "conversation", file);
        await mkdir(path.dirname(target), { recursive: true });
        await writeFile(
          target,
          name === "actor"
            ? block(name).replace(
                "visibility: system",
                "visibility: system\n  concealed: true",
              )
            : block(name),
        );
      }
      vi.stubEnv("COVEL_USER_PLUGINS_DIR", user);
      vi.stubEnv("COVEL_DESKTOP_REST_TOKEN", "synthetic-orchestration-token");
      vi.stubEnv("NODE_ENV", "production");
      const now = new Date().toISOString();
      await store.createSession({
        id: "scene",
        status: "active",
        phase: "playing",
        seats: [
          {
            id: "main",
            controller: "human",
            role: "player",
            characters: "auto",
          },
        ],
        activePlugins: [],
        setupRuntimes: {},
        completedPlayerTurns: 0,
        locale: "en-US",
        metadata: {
          approvalScopeNonce: crypto.randomUUID(),
          sessionIncarnationNonce: crypto.randomUUID(),
        },
        createdAt: now,
        updatedAt: now,
      });
      for (const [id, name] of [
        ["private-mara", "Mara"],
        ["private-ivo", "Ivo"],
      ] as const)
        await store.upsertCharacter({
          id,
          name,
          sessionId: "scene",
          type: "npc",
          version: 1,
          createdAt: now,
          updatedAt: now,
        });
      let parentCalls = 0;
      let actorCalls = 0;
      const llm: LLMAdapter = {
        generate: async ({ messages }) => {
          const system = messages
            .filter((message) => message.role === "system")
            .map((message) => String(message.content))
            .join("\n");
          const text = JSON.stringify(messages);
          if (system.includes("Play only the supplied character")) {
            actorCalls++;
            expect(text).not.toMatch(/private-mara|private-ivo|PARENT-SECRET/);
            if (text.includes('"name":"Ivo"') || text.includes('"name": "Ivo"'))
              throw new Error("PRIVATE-ACTOR-FAILURE");
            return reply({
              segments: [{ kind: "dialogue", text: "I will listen." }],
              intent: "PRIVATE-ACTOR-INTENT",
            });
          }
          parentCalls++;
          if (parentCalls === 1)
            return call(
              "choose-speakers",
              { present: ["Mara", "Ivo"], recentSegments: [] },
              "policy",
            );
          if (parentCalls === 2) {
            expect(text).not.toMatch(/private-mara|private-ivo/);
            expect(text).toContain("Mara");
            return call(
              "delegate",
              {
                target: { contract: "character-actor@1" },
                character: "Mara",
                brief: "PRIVATE-ACTOR-BRIEF",
              },
              "mara",
            );
          }
          expect(text).toContain("PRIVATE-ACTOR-INTENT");
          if (parentCalls === 3)
            return call(
              "delegate",
              {
                target: { contract: "character-actor@1" },
                character: "Ivo",
                brief: "PRIVATE-ACTOR-BRIEF",
              },
              "ivo",
            );
          return reply({
            segments: [
              { kind: "dialogue", speaker: "Mara", text: "I will listen." },
              { kind: "narration", text: "The quiet continues." },
            ],
            cues: { present: ["Mara", "Ivo"] },
          });
        },
      };
      boot = await bootstrapApi({
        pluginsDir: builtin,
        pluginsDirs: [builtin, user],
        store,
        storeBackend: "memory",
        llmAdapter: llm,
      });
      const app = boot.app;
      const request = (url: string, method = "GET", body?: unknown) =>
        app.request(url, {
          method,
          headers: {
            Authorization: "Bearer synthetic-orchestration-token",
            "Content-Type": "application/json",
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
      const approved = async (url: string, method: string, body?: unknown) => {
        for (let attempt = 0; attempt < 10; attempt++) {
          const result = await request(url, method, body);
          if (result.status !== 202) return result;
          const pending = (await result.clone().json()) as {
            status: string;
            approvalId: string;
          };
          if (pending.status !== "approval-required") return result;
          const decision = await request(
            `/api/approvals/${pending.approvalId}/decision`,
            "POST",
            { decision: "allow", scope: "session" },
          );
          expect(decision.status, await decision.text()).toBe(200);
        }
        throw new Error("Approval did not settle");
      };
      expect(boot.registry.get("conversation")?.source).toBe("community");
      const enabled = await approved(
        "/api/sessions/scene/plugins/conversation",
        "PUT",
      );
      expect(enabled.status, await enabled.text()).toBe(200);
      // Obtain runtime grants through the same review endpoint used by a player.
      for (const runtimeId of ["conversation/story", "conversation/actor"]) {
        const pending = await request(
          "/api/sessions/scene/plugin-rpc",
          "POST",
          { kind: "runtime", pluginId: "conversation", runtimeId, payload: {} },
        );
        if (pending.status === 202) {
          const approval = (await pending.json()) as { approvalId: string };
          expect(
            (
              await request(
                `/api/approvals/${approval.approvalId}/decision`,
                "POST",
                { decision: "allow", scope: "session" },
              )
            ).status,
          ).toBe(200);
        }
      }
      const available = await request("/api/sessions/scene/orchestration");
      expect(await available.json()).toMatchObject({
        status: "ambiguous",
        policies: [
          expect.objectContaining({ name: "draw" }),
          expect.objectContaining({ name: "ensemble" }),
        ],
      });
      expect(
        (
          await request("/api/sessions/scene/orchestration", "PATCH", {
            turnPolicy: { pluginId: "conversation", name: "ensemble" },
          })
        ).status,
      ).toBe(200);
      const response = await approved("/api/actions", "POST", {
        requestId: crypto.randomUUID(),
        sessionId: "scene",
        type: "submit_actions",
        payload: { actions: [{ kind: "say", text: "PARENT-SECRET" }] },
      });
      const stream = await response.text();
      expect(response.status, stream).toBe(200);
      const events = stream
        .split("\n")
        .filter((line) => line.startsWith("data: "))
        .map(
          (line) =>
            JSON.parse(line.slice(6)) as {
              type: string;
              payload: Record<string, unknown>;
            },
        );
      expect(
        events.filter((event) => event.type === "narrative.completed"),
      ).toHaveLength(1);
      expect(events.some((event) => event.type === "execution.completed")).toBe(
        true,
      );
      expect(
        events.some(
          (event) =>
            event.type === "runtime.failed" || event.type === "error.occurred",
        ),
      ).toBe(false);
      expect(parentCalls).toBe(4);
      expect(actorCalls).toBeGreaterThanOrEqual(2);
      expect((await store.listTurnResults("scene"))[0]?.commitStatus).toBe(
        "committed",
      );
      const turns = await request("/api/sessions/scene/turns");
      const traces = await request("/api/traces/scene");
      expect(turns.status).toBe(200);
      expect(traces.status).toBe(200);
      expect(stream + (await turns.text()) + (await traces.text())).not.toMatch(
        /PRIVATE-ACTOR-INTENT|PRIVATE-ACTOR-BRIEF|PRIVATE-ACTOR-FAILURE/,
      );
      await closeTestApi(boot);
      boot = await bootstrapApi({
        pluginsDir: builtin,
        pluginsDirs: [builtin, user],
        store,
        storeBackend: "memory",
        llmAdapter: llm,
      });
      expect(
        await (
          await boot.app.request("/api/sessions/scene/orchestration", {
            headers: { Authorization: "Bearer synthetic-orchestration-token" },
          })
        ).json(),
      ).toMatchObject({
        settings: {
          turnPolicy: { pluginId: "conversation", name: "ensemble" },
        },
      });
    } finally {
      await closeTestApi(boot);
      await store.close();
      await rm(root, { recursive: true, force: true });
    }
  });
});
