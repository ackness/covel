import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { createMemoryStore } from "@covel/store/memory";
import type { LLMAdapter } from "@covel/runtime";
import {
  bootstrapApi,
  type ApiBootstrapResult,
} from "../../src/routes/api/bootstrap.js";
import { closeTestApi } from "../helpers/close-api.js";

const project = path.resolve(import.meta.dirname, "../../../..");

type Generate = LLMAdapter["generate"];

const nameField = {
  type: "text",
  name: "characterName",
  label: "Name",
  required: true,
};

/** A model that answers the character runtime with the opening form. */
const openingForm =
  (fields: unknown[] = []): Generate =>
  async (request) => {
    const formTool = request.tools?.find(
      (tool) => tool.name === "create-character-form",
    );
    if (!formTool) throw new Error("Unexpected model call");
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
            fields: [nameField, ...fields],
            submitBehavior: { echoFilledNarrative: true, immediate: true },
            narrativeTemplate: "{{characterName}} begins.",
          }),
        },
      ],
      finishReason: "tool_calls",
      usage: { inputTokens: 1, outputTokens: 1 },
    };
  };

const persona = {
  id: "persona",
  name: "Personality",
  type: "string",
  category: "bio",
  defaultValue: "Quiet",
} as const;
const personaField = { type: "text", name: "persona", label: "Personality" };

async function harness(options: {
  generate: Generate;
  /** Omit for a world that declares no character schema. */
  attributes?: unknown[];
  plugins?: string[];
  locale?: string;
}) {
  const root = await mkdtemp(path.join(tmpdir(), "covel-setup-dead-end-"));
  const store = createMemoryStore();
  const sessionId = crypto.randomUUID();
  const generate = vi.fn<Generate>(options.generate);
  vi.stubEnv("COVEL_USER_PLUGINS_DIR", root);
  vi.stubEnv("NODE_ENV", "development");
  const boot: ApiBootstrapResult = await bootstrapApi({
    pluginsDir: path.join(project, "plugins"),
    pluginsDirs: [path.join(project, "plugins"), root],
    store,
    storeBackend: "memory",
    llmAdapter: { generate },
  });
  const now = new Date().toISOString();
  await store.upsertWorld({
    id: "setup-world",
    name: "Setup world",
    description: "A synthetic world",
    createdAt: now,
    ...(options.attributes
      ? {
          metadata: {
            characterSchema: { types: ["npc"], attributes: options.attributes },
          },
        }
      : {}),
  });
  await store.createSession({
    id: sessionId,
    worldId: "setup-world",
    status: "active",
    phase: "setup",
    setupRuntimes: {},
    completedPlayerTurns: 0,
    activePlugins: options.plugins ?? ["pregame", "world-init", "char-creator"],
    locale: options.locale ?? "en-US",
    metadata: {
      approvalScopeNonce: crypto.randomUUID(),
      sessionIncarnationNonce: crypto.randomUUID(),
    },
    createdAt: now,
    updatedAt: now,
  });
  const post = (url: string, body: unknown) =>
    boot.app.request(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  return {
    store,
    sessionId,
    generate,
    boot,
    post,
    /** Run one action and return what it committed. */
    async action(type: string, payload: unknown = {}) {
      const response = await post("/api/actions", {
        requestId: crypto.randomUUID(),
        sessionId,
        type,
        payload,
      });
      const body = await response.text();
      expect(response.status, body).toBe(200);
      return (await store.listTurnResults(sessionId)).at(-1)!;
    },
    session: async () => (await store.getSession(sessionId))!,
    player: async () =>
      (await store.listCharacters(sessionId)).find(
        (character) => character.type === "player",
      ),
    /** The newest committed form with this id. */
    async form(id: string) {
      const found: {
        turnId: string;
        form: { interactionId: string } & Record<string, unknown>;
      }[] = [];
      for (const message of await store.listTurnMessages(sessionId)) {
        if (!Array.isArray(message.pendingInput)) continue;
        for (const item of message.pendingInput)
          if (item.interactionId === id)
            found.push({
              turnId: message.turnId,
              form: item as (typeof found)[number]["form"],
            });
      }
      return found.at(-1);
    },
    async submit(
      target: { turnId: string; form: { interactionId: string } },
      values: Record<string, unknown>,
    ) {
      const response = await post(`/api/sessions/${sessionId}/plugin-rpc`, {
        kind: "action",
        pluginId: "framework",
        action: "submit-form",
        payload: {
          turnId: target.turnId,
          submissions: [
            {
              interactionId: target.form.interactionId,
              type: "form",
              values,
            },
          ],
        },
      });
      return { status: response.status, body: await response.json() };
    },
    async close() {
      await closeTestApi(boot);
      await store.close();
      vi.unstubAllEnvs();
      await rm(root, { recursive: true, force: true });
    },
  };
}

it("retries a failed character setup in the same session", async () => {
  let offline = true;
  const h = await harness({
    attributes: [persona],
    generate: async (request) => {
      if (offline) throw new Error("Synthetic provider failure");
      return openingForm([personaField])(request);
    },
  });
  try {
    const failed = await h.action("start_session");
    expect(failed.runtimeResults).toContainEqual(
      expect.objectContaining({
        runtimeId: "char-creator/player-init",
        status: "failed",
      }),
    );
    // The opening is committed, so the "begin" screen is gone; the session
    // record is what tells the client that setup needs another run.
    expect((await h.session()).setupRuntimes).toMatchObject({
      "char-creator/player-init": {
        state: "pending",
        lastError: expect.stringContaining("Synthetic provider failure"),
      },
    });
    expect(await h.form("char-creation")).toBeUndefined();

    offline = false;
    const retried = await h.action("start_session");
    // Only the unfinished step runs again, and no player message is recorded.
    expect(retried.runtimeResults.map((result) => result.runtimeId)).toEqual([
      "char-creator/player-init",
    ]);
    expect(
      (await h.store.listTurnMessages(h.sessionId)).filter(
        (message) => message.sourceType === "player",
      ),
    ).toEqual([]);
    const form = await h.form("char-creation");
    expect((await h.submit(form!, { characterName: "Ada" })).status).toBe(200);
    await h.action("send_message", { content: "Ada begins." });
    expect((await h.player())?.name).toBe("Ada");
    expect((await h.session()).phase).toBe("playing");
  } finally {
    await h.close();
  }
}, 60_000);

it("continues a setup whose form was submitted before the page closed", async () => {
  const h = await harness({
    attributes: [persona],
    generate: openingForm([personaField]),
  });
  try {
    await h.action("start_session");
    const form = await h.form("char-creation");
    expect((await h.submit(form!, { characterName: "Ada" })).status).toBe(200);
    // The client never sent the message that follows a submission. Running
    // setup again reads the stored form and goes on into the opening.
    await h.action("start_session");
    expect((await h.player())?.name).toBe("Ada");
    expect((await h.session()).phase).toBe("playing");
  } finally {
    await h.close();
  }
}, 60_000);

it("creates the character when an attribute default fails its own type", async () => {
  const h = await harness({
    generate: openingForm([personaField]),
    attributes: [
      persona,
      {
        id: "rank",
        name: "Rank",
        type: "enum",
        category: "bio",
        options: ["low", "high"],
        defaultValue: "middle",
      },
    ],
  });
  try {
    await h.action("start_session");
    const form = await h.form("char-creation");
    expect(
      (await h.submit(form!, { characterName: "Ada", persona: "Curious" }))
        .status,
    ).toBe(200);
    await h.action("send_message", { content: "Ada begins." });
    expect((await h.player())?.fields).toEqual({ persona: "Curious" });
    expect((await h.session()).phase).toBe("playing");
  } finally {
    await h.close();
  }
}, 60_000);

it("offers the form again, filled in, when the world no longer accepts a submission", async () => {
  const moods = ["calm", "stern"];
  // The model follows the world's attribute types of the moment.
  let strict = false;
  const h = await harness({
    attributes: [persona],
    generate: (request) =>
      openingForm([
        strict
          ? { ...personaField, type: "select", options: moods }
          : personaField,
      ])(request),
    locale: "zh-CN",
  });
  try {
    await h.action("start_session");
    const first = await h.form("char-creation");
    expect(
      (await h.submit(first!, { characterName: "Ada", persona: "Curious" }))
        .status,
    ).toBe(200);
    // The attribute types change between the form and the run that reads it.
    const schema = (await h.store.getCharacterSchema(h.sessionId))!;
    await h.store.upsertCharacterSchema({
      ...schema,
      attributes: [
        { ...persona, type: "enum", options: moods, defaultValue: "calm" },
      ],
    });
    strict = true;

    const turn = await h.action("send_message", { content: "Ada begins." });
    expect(
      turn.runtimeResults.filter((result) => result.status === "failed"),
    ).toEqual([]);
    expect(await h.player()).toBeUndefined();
    const again = await h.form("char-creation");
    expect(again!.turnId).toBe(turn.turnId);
    expect(again!.form.notice).toBe(
      "这个世界不再接受你之前填写的部分内容，请检查后重新提交。",
    );
    // The name is kept; the answer the world refuses is asked again.
    expect(again!.form.fields).toEqual([
      expect.objectContaining({ name: "characterName", defaultValue: "Ada" }),
      expect.not.objectContaining({ defaultValue: expect.anything() }),
    ]);

    expect(
      (await h.submit(again!, { characterName: "Ada", persona: "stern" }))
        .status,
    ).toBe(200);
    await h.action("send_message", { content: "Ada begins." });
    expect((await h.player())?.fields).toEqual({ persona: "stern" });
    expect((await h.session()).phase).toBe("playing");
  } finally {
    await h.close();
  }
}, 60_000);

it("goes on without a schema after the player skips the failed schema step", async () => {
  let offline = true;
  const h = await harness({
    generate: async (request) => {
      if (offline) throw new Error("Synthetic provider failure");
      return openingForm()(request);
    },
  });
  try {
    await h.action("start_session");
    const blocked = (await h.session()).setupRuntimes["world-init/schema-gen"];
    // The blocked step keeps the error that used up its only attempt.
    expect(blocked).toMatchObject({
      state: "blocked",
      lastError: expect.stringContaining("Synthetic provider failure"),
    });

    offline = false;
    const waived = await h.post(
      `/api/sessions/${h.sessionId}/setup/${encodeURIComponent("world-init/schema-gen")}/waive`,
      { confirm: true },
    );
    expect(waived.status, await waived.text()).toBe(200);
    await h.action("start_session");
    const form = await h.form("char-creation");
    expect((await h.submit(form!, { characterName: "Ada" })).status).toBe(200);
    await h.action("send_message", { content: "Ada begins." });
    expect((await h.player())?.name).toBe("Ada");
    expect((await h.session()).phase).toBe("playing");
  } finally {
    await h.close();
  }
}, 60_000);

it("tells the player in their language what to correct, and keeps the form open", async () => {
  const ability = (id: string, name: string) => ({
    id,
    name: { "zh-CN": name, "en-US": id },
    type: "number",
    category: "abilities",
    min: 0,
    max: 5,
    defaultValue: 1,
  });
  const h = await harness({
    generate: openingForm(),
    attributes: [ability("might", "力量"), ability("wits", "机敏")],
    plugins: ["pregame", "world-init", "char-creator", "tabletop-rules"],
    locale: "zh-CN",
  });
  try {
    await h.action("start_session");
    const opening = await h.form("char-creation");
    const unnamed = await h.submit(opening!, {});
    expect(unnamed).toEqual({
      status: 400,
      body: { code: "form_rejected", error: "请填写“Name”。" },
    });
    expect((await h.submit(opening!, { characterName: "Ada" })).status).toBe(
      200,
    );
    await h.action("send_message", { content: "Ada begins." });

    const allocation = await h.form("tabletop-rules-allocation");
    const overspent = await h.submit(allocation!, { might: 5, wits: 5 });
    expect(overspent).toEqual({
      status: 400,
      body: {
        code: "form_rejected",
        error: "需要正好分配 4 点，你已分配 8 点",
      },
    });
    // Nothing was stored: the same form takes the corrected values.
    expect(
      (await h.store.listPlayerInputs(h.sessionId)).map(
        (input) => input.formId,
      ),
    ).toEqual(["char-creation"]);
    expect((await h.submit(allocation!, { might: 3, wits: 3 })).status).toBe(
      200,
    );
    await h.action("send_message", { content: "Allocation complete." });
    expect((await h.player())?.fields).toMatchObject({ might: 3, wits: 3 });
    expect((await h.session()).phase).toBe("playing");
  } finally {
    await h.close();
  }
}, 60_000);
