import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  WORLD_LOCALIZED_TEXT_KEY,
  resolveI18nText,
  type SessionSnapshot,
  type World,
} from "@covel/shared";
import { createMemoryStore } from "@covel/store/memory";
import {
  bootstrapApi,
  type ApiBootstrapResult,
} from "../../src/routes/api/bootstrap.js";
import { loadSingleWorld } from "../../src/world-seed-loader.js";
import { closeTestApi } from "../helpers/close-api.js";

const WORLD_ID = "fallback-world";
const SOURCE_LORE = "The harbor beacon has guarded the shore for 43 years.";
const SECRET = {
  file: "SECRET_FILE_SENTINEL",
  key: "SECRET_KEY_SENTINEL",
  text: "SECRET_TEXT_SENTINEL",
};
const CHARACTERS = [
  {
    id: "keeper",
    name: "Mara",
    type: "npc",
    description: "The harbor keeper.",
    fields: { resolve: 29 },
    blueprint: { voice: "Short sentences, evidence first.", patience: 6 },
  },
  { id: "clerk", name: "Rook", type: "npc", description: "The clerk." },
] as const;
const CHAPTERS = [
  {
    id: "chapter-a",
    text: "Source first chapter.",
    count: 31,
    sections: [
      { label: "west", text: "Source western quay.", count: 3 },
      { label: "east", text: "Source eastern quay.", count: 7 },
    ],
  },
  {
    id: "chapter-b",
    text: "Source second chapter.",
    count: 47,
    sections: [
      { label: "west", text: "Source western tower.", count: 11 },
      { label: "east", text: "Source eastern tower.", count: 13 },
    ],
  },
] as const;

/** Only the root and one nested source have Japanese overlays. */
async function writeFixture(root: string) {
  const pluginsDir = path.join(root, "plugins");
  const worldsDir = path.join(root, "worlds");
  const worldRoot = path.join(worldsDir, WORLD_ID);
  const write = async (file: string, value: unknown) => {
    const absolute = path.join(root, file);
    await mkdir(path.dirname(absolute), { recursive: true });
    await writeFile(
      absolute,
      typeof value === "string" ? value : JSON.stringify(value),
    );
  };
  // Exercise the real dimension authority, including its /view extension.
  await cp(
    path.resolve(import.meta.dirname, "../../../../plugins/world-init"),
    path.join(pluginsDir, "world-init"),
    { recursive: true },
  );
  await write("plugins/probe/schemas/notes.json", {
    type: "object",
    required: ["id", "text", "count"],
    properties: {
      id: { type: "string" },
      text: { type: "string" },
      count: { type: "integer" },
      sections: {
        type: "array",
        items: {
          type: "object",
          required: ["label", "text", "count"],
          properties: {
            label: { type: "string" },
            text: { type: "string" },
            count: { type: "integer" },
          },
        },
      },
    },
  });
  await write("plugins/probe/schemas/profiles.json", {
    type: "object",
    required: ["voice", "patience"],
    properties: {
      voice: { type: "string" },
      patience: { type: "integer" },
    },
    additionalProperties: false,
  });
  await write(
    "plugins/probe/PLUGIN.md",
    `---\n${JSON.stringify({
      id: "probe",
      version: "0.1.0",
      description: "Locale fallback receiver",
      contracts: {
        "probe.notes@1": { schema: "./schemas/notes.json" },
        "probe.profiles@1": { schema: "./schemas/profiles.json" },
      },
      contributes: {
        data: {
          notes: {
            accepts: ["probe.notes@1"],
            schema: "./schemas/notes.json",
            authoring: { title: "Harbor notes" },
          },
          profiles: {
            accepts: ["probe.profiles@1"],
            schema: "./schemas/profiles.json",
            authoring: {
              title: "Character notes",
              characterField: "blueprint",
            },
          },
        },
      },
    })}\n---\n`,
  );
  await write(
    "plugins/story/PLUGIN.md",
    "---\nid: story\ndescription: Story\nruntime:\n  schedule: { stage: narrative }\n  io:\n    visibility: story\n    output: { contract: narrative-engine@2 }\n---\nTell the story using this lore: {{ world.lore }}\n",
  );
  const worldPath = `worlds/${WORLD_ID}`;
  await write(`${worldPath}/world.yaml`, {
    id: WORLD_ID,
    name: "Source harbor",
    summary: "Source harbor summary.",
    defaultLocale: "en-US",
    pluginPitch: { label: "Harbor watch", description: "Keep the beacon lit." },
    worldData: "data/world.data.yaml",
    characterSchema: {
      types: ["npc"],
      attributes: [
        { id: "resolve", name: "Resolve", type: "number", category: "stats" },
      ],
    },
  });
  await write(`${worldPath}/world.ja-JP.yaml`, { name: "港の世界" });
  await write(`${worldPath}/WORLD.md`, SOURCE_LORE);
  await write(`${worldPath}/data/dimensions.yaml`, {
    signal: {
      name: "Signal",
      description: "The beacon signal.",
      schema: { type: "string", "x-i18n": true },
      initialValue: "The lamp holds.",
    },
    alarm: { name: "Alarm", schema: { type: "integer" }, initialValue: 17 },
  });
  await write(`${worldPath}/characters/characters.json`, CHARACTERS);
  await write(`${worldPath}/data/lorebook.yaml`, [
    { id: "harbor-rule", content: "Source harbor rule.", strategy: "constant" },
  ]);
  await write(`${worldPath}/data/facts.json`, [
    { id: "ordinary", text: "Source fact.", count: 23 },
  ]);
  await write(`${worldPath}/data/chapters.json`, CHAPTERS);
  // Reverse both levels and omit text/rows: a positional merge would put
  // the translations on the wrong identities or discard source content.
  await write(`${worldPath}/data/chapters.ja-JP.json`, [
    { id: "chapter-b", sections: [{ label: "east", text: "東の塔。" }] },
    {
      id: "chapter-a",
      sections: [
        { label: "east", text: "東の波止場。" },
        { label: "west", text: "西の波止場。" },
      ],
    },
  ]);
  await write(`${worldPath}/data/hidden/${SECRET.file}.json`, [
    { id: SECRET.key, text: SECRET.text, count: 71 },
  ]);
  await write(`${worldPath}/data/world.data.yaml`, {
    sources: {
      facts: {
        kind: "json",
        path: "data/facts.json",
        to: "contract:probe.notes@1",
        key: "id",
      },
      chapters: {
        kind: "json",
        path: "data/chapters.json",
        to: "contract:probe.notes@1",
        key: "id",
        localeArrayKeys: ["label"],
      },
      "hidden-facts": {
        kind: "json",
        path: `data/hidden/${SECRET.file}.json`,
        to: "contract:probe.notes@1",
        key: "id",
        visibility: "hidden",
      },
    },
  });
  return { pluginsDir, worldsDir, worldRoot };
}

describe("world locale fallback through the player API", () => {
  it.each([
    ["ja-JP", "ja-JP"],
    ["fr-FR", "en-US"],
  ])(
    "creates a %s session in edition %s without losing or exposing source data",
    async (requested, selected) => {
      const root = await mkdtemp(path.join(tmpdir(), "world-locale-api-"));
      const store = createMemoryStore();
      let boot: ApiBootstrapResult | undefined;
      try {
        const fixture = await writeFixture(root);
        const modelPrompts: string[] = [];
        boot = await bootstrapApi({
          pluginsDir: fixture.pluginsDir,
          worldsDirs: [fixture.worldsDir],
          covelHome: root,
          store,
          storeBackend: "memory",
          llmAdapter: {
            generate: async (request) => {
              modelPrompts.push(JSON.stringify(request.messages));
              return {
                content: JSON.stringify({
                  segments: [{ kind: "narration", text: "The beacon shines." }],
                  cues: { present: [] },
                }),
                toolCalls: [],
                finishReason: "stop",
                usage: { inputTokens: 1, outputTokens: 1 },
              };
            },
          },
        });
        const world = await loadSingleWorld(fixture.worldRoot, {
          covelHome: root,
        });
        if (!world) throw new Error("World fixture failed to load");
        await store.upsertWorld(world);
        const app = boot.app;
        const post = (url: string, body: unknown) =>
          app.request(url, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
          });
        const publicText = async (response: Response, status = 200) => {
          const text = await response.text();
          expect(response.status, text).toBe(status);
          for (const sentinel of Object.values(SECRET))
            expect(text).not.toContain(sentinel);
          return text;
        };
        const publicJson = async (response: Response, status = 200) =>
          JSON.parse(await publicText(response, status));

        const publicWorld = (await publicJson(
          await app.request(`/api/worlds/${WORLD_ID}`),
        )) as World;
        expect(publicWorld.description).toBe("Source harbor summary.");
        expect(publicWorld.metadata?.pluginPitch).toEqual({
          label: "Harbor watch",
          description: "Keep the beacon lit.",
        });
        expect(publicWorld.metadata?.[WORLD_LOCALIZED_TEXT_KEY]).toMatchObject({
          name: { "ja-JP": "港の世界" },
          lore: { "ja-JP": SOURCE_LORE },
        });
        await publicJson(await app.request("/api/worlds"));
        await publicJson(
          await app.request(`/api/worlds/${WORLD_ID}/plugin-plan`),
        );
        const preflight = await publicJson(
          await post(`/api/worlds/${WORLD_ID}/world-data/preflight`, {
            plugins: ["story"],
            locale: requested,
          }),
        );
        expect(preflight.diagnostics).toEqual([]);

        const created = await publicJson(
          await post("/api/sessions", {
            id: "fallback-session",
            worldId: WORLD_ID,
            plugins: ["story"],
            locale: requested,
          }),
          201,
        );
        expect(created.locale).toBe(selected);
        if (requested === selected)
          expect(created).not.toHaveProperty("requestedLocale");
        else expect(created.requestedLocale).toBe(requested);
        expect(created.worldDataNotices ?? []).toEqual([]);
        expect(created.activePlugins).toEqual(
          expect.arrayContaining(["story", "probe", "world-init"]),
        );
        expect((await store.getSession("fallback-session"))?.locale).toBe(
          selected,
        );

        const notes = await store.listPluginData(
          "fallback-session",
          "probe",
          "notes",
        );
        const localizedChapters =
          selected === "ja-JP"
            ? [
                {
                  ...CHAPTERS[0],
                  sections: [
                    { label: "west", text: "西の波止場。", count: 3 },
                    { label: "east", text: "東の波止場。", count: 7 },
                  ],
                },
                {
                  ...CHAPTERS[1],
                  sections: [
                    { label: "west", text: "Source western tower.", count: 11 },
                    { label: "east", text: "東の塔。", count: 13 },
                  ],
                },
              ]
            : CHAPTERS;
        expect(
          notes
            .map(({ key, value }) => ({ key, value }))
            .sort((a, b) => a.key.localeCompare(b.key)),
        ).toEqual([
          ...localizedChapters.map((value) => ({ key: value.id, value })),
          {
            key: "ordinary",
            value: { id: "ordinary", text: "Source fact.", count: 23 },
          },
        ]);
        expect(
          await store.listPluginData(
            "fallback-session",
            "probe",
            "_hidden.notes",
          ),
        ).toMatchObject([
          {
            key: SECRET.key,
            value: { id: SECRET.key, text: SECRET.text, count: 71 },
          },
        ]);
        expect(
          await store.listPluginData("fallback-session", "probe", "profiles"),
        ).toMatchObject([{ key: "keeper", value: CHARACTERS[0].blueprint }]);
        expect(
          await store.listSessionLorebookEntries("fallback-session"),
        ).toMatchObject([{ content: "Source harbor rule." }]);
        const ledger =
          await store.listWorldDataImportLedger("fallback-session");
        const identities = ledger.map(({ target, pluginId, namespace, key }) =>
          JSON.stringify([target, pluginId, namespace, key]),
        );
        expect(identities).toHaveLength(10);
        expect(new Set(identities).size).toBe(identities.length);

        const opening = await post("/api/actions", {
          requestId: crypto.randomUUID(),
          sessionId: "fallback-session",
          type: "start_session",
          payload: {},
        });
        await publicText(opening);
        expect(modelPrompts.length).toBeGreaterThan(0);
        expect(modelPrompts.join("\n")).toContain(SOURCE_LORE);
        expect(
          (await store.listTurnResults("fallback-session")).at(-1)
            ?.commitStatus,
        ).toBe("committed");

        const view = (await publicJson(
          await app.request("/api/sessions/fallback-session/view"),
        )) as SessionSnapshot;
        expect(view.session.locale).toBe(selected);
        expect(view.dimensions.alarm).toMatchObject({ value: 17 });
        expect(view.dimensions.signal).toMatchObject({
          value: "The lamp holds.",
        });
        expect(resolveI18nText(view.dimensions.signal?.name, selected)).toBe(
          "Signal",
        );
        expect(view.characters).toMatchObject([
          {
            id: "keeper",
            name: "Mara",
            description: "The harbor keeper.",
            fields: { resolve: 29 },
          },
          { id: "clerk", name: "Rook", description: "The clerk." },
        ]);
        for (const suffix of [
          "",
          "/state",
          "/plugin-data",
          "/plugin-data/probe",
          "/plugin-data/probe/_index",
          "/lorebook",
        ]) {
          await publicJson(
            await app.request(`/api/sessions/fallback-session${suffix}`),
          );
        }
        const publicNotes = await publicJson(
          await app.request(
            "/api/sessions/fallback-session/plugin-data/probe/notes",
          ),
        );
        expect(publicNotes.items).toHaveLength(3);
        await publicJson(
          await app.request(
            `/api/sessions/fallback-session/plugin-data/probe/_hidden.notes/${SECRET.key}`,
          ),
          404,
        );

        // Make the hidden-source notice nonempty and inspect its real projection.
        const excluded = await publicJson(
          await post("/api/sessions", {
            id: "excluded-session",
            worldId: WORLD_ID,
            plugins: ["story"],
            excludedPlugins: ["probe"],
            locale: requested,
          }),
          201,
        );
        expect(excluded.worldDataNotices).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ code: "receiver-excluded" }),
          ]),
        );
        expect(excluded.worldDataNotices).toHaveLength(4);
        expect(excluded.worldDataNotices).toContainEqual({
          code: "receiver-excluded",
          level: "warning",
          message: expect.any(String),
        });
        expect(JSON.stringify(excluded.worldDataNotices)).not.toContain(
          "hidden-facts",
        );
        expect(
          await store.listPluginData(
            "excluded-session",
            "probe",
            "_hidden.notes",
          ),
        ).toEqual([]);
      } finally {
        await closeTestApi(boot);
        await store.close();
        await rm(root, { recursive: true, force: true });
      }
    },
  );
});
