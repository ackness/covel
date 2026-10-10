import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { parse } from "yaml";
import { expect, it, vi } from "vitest";
import { createMemoryStore } from "@covel/store/memory";
import { createSqliteStore } from "@covel/store/sqlite";
import type { LLMAdapter } from "@covel/runtime";
import {
  bootstrapApi,
  type ApiBootstrapResult,
} from "../../src/routes/api/bootstrap.js";
import { closeTestApi } from "../helpers/close-api.js";
import {
  buildTabletopProbeZip,
  tabletopProbeId,
} from "../helpers/tabletop-package.js";
import { runtimeResultsOf } from "../helpers/runtime-results.js";

for (const community of [false, true]) {
  for (const hasAbilities of [true, false]) {
    it(`real opening: ${community ? "community" : "builtin"}, abilities=${hasAbilities}`, async () => {
      const project = path.resolve(import.meta.dirname, "../../../..");
      const root = await mkdtemp(
        path.join(tmpdir(), "covel-tabletop-opening-"),
      );
      const user = path.join(root, "plugins");
      await mkdir(user);
      const store = createSqliteStore(path.join(root, "session.sqlite"));
      const pluginId = community ? tabletopProbeId : "tabletop-rules";
      const sessionId = crypto.randomUUID();
      const generate = vi.fn<LLMAdapter["generate"]>(async (request) => {
        const formTool = request.tools?.find(
          (tool) => tool.name === "create-character-form",
        );
        if (!formTool)
          throw new Error("Unexpected model call outside the opening form");
        return {
          content: "Your story begins.",
          toolCalls: [
            {
              id: "opening-form-tool",
              name: formTool.name,
              arguments: JSON.stringify({
                formId: "char-creation",
                title: "Create your character",
                submitLabel: "Create",
                fields: [
                  {
                    type: "text",
                    name: "characterName",
                    label: "Name",
                    required: true,
                  },
                  { type: "text", name: "persona", label: "Personality" },
                ],
                submitBehavior: { echoFilledNarrative: true, immediate: true },
                narrativeTemplate: "{{characterName}} begins.",
              }),
            },
          ],
          finishReason: "tool_calls",
          usage: { inputTokens: 1, outputTokens: 1 },
        };
      });
      let boot: ApiBootstrapResult | undefined;
      vi.stubEnv("COVEL_USER_PLUGINS_DIR", user);
      vi.stubEnv("NODE_ENV", "development");
      const start = () =>
        bootstrapApi({
          pluginsDir: path.join(project, "plugins"),
          pluginsDirs: [path.join(project, "plugins"), user],
          store,
          storeBackend: "sqlite",
          llmAdapter: { generate },
        });
      try {
        boot = await start();
        if (community) {
          const upload = new FormData();
          upload.append(
            "file",
            new Blob([new Uint8Array(await buildTabletopProbeZip())]),
            "tabletop-probe.zip",
          );
          const installed = await boot.app.request("/api/install/plugin", {
            method: "POST",
            body: upload,
          });
          expect(installed.status, await installed.text()).toBe(201);
          await closeTestApi(boot);
          boot = await start();
        }
        const world = parse(
          await readFile(
            path.join(project, "worlds/mistport/world.yaml"),
            "utf8",
          ),
        );
        const attributes = [
          ...(hasAbilities ? world.characterSchema.attributes : []),
          {
            id: "persona",
            name: { "en-US": "Personality" },
            type: "string",
            category: "bio",
            defaultValue: "Quiet",
          },
        ];
        const now = new Date().toISOString();
        await store.upsertWorld({
          id: "opening-world",
          name: "Opening Test World",
          description: "A synthetic opening world",
          createdAt: now,
          metadata: {
            characterSchema: { types: ["npc", "companion"], attributes },
          },
        });
        await store.createSession({
          id: sessionId,
          worldId: "opening-world",
          status: "active",
          phase: "setup",
          setupRuntimes: {},
          completedPlayerTurns: 0,
          activePlugins: ["pregame", "world-init", "char-creator", pluginId],
          locale: "en-US",
          metadata: {
            approvalScopeNonce: crypto.randomUUID(),
            sessionIncarnationNonce: crypto.randomUUID(),
          },
          createdAt: now,
          updatedAt: now,
        });
        async function request(url: string, body: unknown) {
          for (let attempt = 0; attempt < 6; attempt++) {
            const response = await boot!.app.request(url, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(body),
            });
            if (response.status !== 202) return response;
            const pending = await response.json();
            const decision = await boot!.app.request(
              `/api/approvals/${pending.approvalId}/decision`,
              {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ decision: "allow", scope: "session" }),
              },
            );
            expect(decision.status, await decision.text()).toBe(200);
          }
          throw new Error("Approval did not settle");
        }
        async function action(type: string, payload: unknown = {}) {
          const response = await request("/api/actions", {
            requestId: crypto.randomUUID(),
            sessionId,
            type,
            payload,
          });
          const body = await response.text();
          expect(response.status, body).toBe(200);
          const last = (await store.listTurnResults(sessionId)).at(-1)!;
          expect(last.commitStatus, body).toBe("committed");
          expect(
            runtimeResultsOf(last).filter(
              (result) => result.status === "failed",
            ),
          ).toEqual([]);
          return last;
        }
        async function form(id: string) {
          for (const message of await store.listTurnMessages(sessionId)) {
            if (!Array.isArray(message.pendingInput)) continue;
            const target = message.pendingInput.find(
              (item) => item.interactionId === id,
            );
            if (target) return { turnId: message.turnId, form: target };
          }
          return undefined;
        }
        /** Answer a form; returns the last turn the request committed. */
        function submit(
          target: NonNullable<Awaited<ReturnType<typeof form>>>,
          values: Record<string, unknown>,
        ) {
          return action("submit_interaction", {
            turnId: target.turnId,
            submissions: [
              {
                interactionId: target.form.interactionId,
                type: "form",
                values,
              },
            ],
          });
        }
        await action("start_session");
        const opening = await form("char-creation");
        expect(opening).toBeDefined();
        expect(await form(`${pluginId}-allocation`)).toBeUndefined();
        expect(await store.listCharacters(sessionId)).toHaveLength(0);
        const creationTurn = await submit(opening!, {
          characterName: "Ada",
          persona: "Curious",
        });
        const player = (await store.listCharacters(sessionId))[0]!;
        expect(
          player,
          JSON.stringify(creationTurn.runtimeResults),
        ).toBeDefined();
        expect(player.name).toBe("Ada");
        expect(player.fields).toMatchObject({ persona: "Curious" });
        const allocation = await form(`${pluginId}-allocation`);
        if (hasAbilities) {
          expect(allocation).toBeDefined();
          expect(allocation!.turnId).toBe(creationTurn.turnId);
          expect((await store.getSession(sessionId))?.phase).toBe("setup");
          // The original form must remain usable after a process restart.
          await closeTestApi(boot);
          boot = await start();
          const rules = (await store.getPluginData(
            sessionId,
            pluginId,
            "setup",
            "rules",
          ))!.value as {
            budget: number;
            attributes: { id: string; base: number }[];
          };
          const values = Object.fromEntries(
            rules.attributes.map((attribute) => [attribute.id, attribute.base]),
          );
          values[rules.attributes[0]!.id]! += rules.budget;
          await submit(allocation!, values);
          const updated = (await store.listCharacters(sessionId))[0]!;
          expect(updated.id).toBe(player.id);
          expect(updated.fields).toMatchObject({
            ...values,
            persona: "Curious",
          });
          expect(updated.version).toBe(player.version + 1);
        } else {
          expect(allocation).toBeUndefined();
          expect(
            await store.getPluginData(sessionId, pluginId, "setup", "rules"),
          ).toBeNull();
        }
        expect((await store.getSession(sessionId))?.phase).toBe("playing");
        expect(generate).toHaveBeenCalledTimes(1);
      } finally {
        await closeTestApi(boot);
        await store.close();
        vi.unstubAllEnvs();
        await rm(root, { recursive: true, force: true });
      }
    }, 30_000);
  }
}

it("does not publish a character form or create a player after schema initialization fails", async () => {
  const project = path.resolve(import.meta.dirname, "../../../..");
  const root = await mkdtemp(path.join(tmpdir(), "covel-opening-failure-"));
  const store = createMemoryStore();
  const sessionId = crypto.randomUUID();
  const generate = vi.fn<LLMAdapter["generate"]>(async () => {
    throw new Error("Synthetic schema generation failure");
  });
  let boot: ApiBootstrapResult | undefined;
  vi.stubEnv("COVEL_USER_PLUGINS_DIR", root);
  vi.stubEnv("NODE_ENV", "development");
  try {
    boot = await bootstrapApi({
      pluginsDir: path.join(project, "plugins"),
      pluginsDirs: [path.join(project, "plugins"), root],
      store,
      storeBackend: "memory",
      llmAdapter: { generate },
    });
    const now = new Date().toISOString();
    await store.upsertWorld({
      id: "no-schema",
      name: "No schema",
      description: "A synthetic world without dimensions or schema",
      createdAt: now,
    });
    await store.createSession({
      id: sessionId,
      worldId: "no-schema",
      status: "active",
      phase: "setup",
      setupRuntimes: {},
      completedPlayerTurns: 0,
      activePlugins: ["pregame", "world-init", "char-creator"],
      locale: "en-US",
      metadata: {
        approvalScopeNonce: crypto.randomUUID(),
        sessionIncarnationNonce: crypto.randomUUID(),
      },
      createdAt: now,
      updatedAt: now,
    });
    const response = await boot.app.request("/api/actions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        requestId: crypto.randomUUID(),
        sessionId,
        type: "start_session",
        payload: {},
      }),
    });
    expect(response.status, await response.text()).toBe(200);
    const results = (await store.listTurnResults(sessionId)).at(
      -1,
    )!.runtimeResults;
    expect(results).toContainEqual(
      expect.objectContaining({
        runtimeId: "world-init/schema-gen",
        status: "failed",
      }),
    );
    expect(results).toContainEqual(
      expect.objectContaining({
        runtimeId: "char-creator/player-init",
        status: "failed",
        error: expect.stringContaining("Character schema is not ready"),
      }),
    );
    expect(generate).toHaveBeenCalledTimes(1);
    expect(await store.getCharacterSchema(sessionId)).toBeNull();
    expect(await store.listCharacters(sessionId)).toEqual([]);
    const messages = await store.listTurnMessages(sessionId);
    expect(
      messages.flatMap((message) =>
        Array.isArray(message.pendingInput) ? message.pendingInput : [],
      ),
    ).toEqual([]);
    expect((await store.getSession(sessionId))?.phase).toBe("setup");
  } finally {
    await closeTestApi(boot);
    await store.close();
    vi.unstubAllEnvs();
    await rm(root, { recursive: true, force: true });
  }
}, 30_000);
