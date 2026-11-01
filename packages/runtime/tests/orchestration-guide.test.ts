import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import {
  discoverPlugins,
  loadPluginDefinition,
  loadRuntime,
  provideHostModules,
  validatePluginPackage,
} from "@covel/plugin-loader";
import type { PluginAPI } from "@covel/plugin-handlers-utils";
import { createMemoryStore, createMemoryMediaStore } from "@covel/store/memory";
import { PluginServiceRegistry } from "../src/plugin-services.js";
import {
  executeTurn,
  commitExecution,
  finalizePresentationJobs,
} from "../src/index.js";
import { prose } from "./_helpers/agent-loop-fixture.js";
import { setup, narrator, input, story } from "./presentation-fixture.js";
import { emptyPresentationDigest } from "../src/presentation/projection.js";
import type { PluginRuntimeGateway } from "@covel/shared/plugin-runtime";
import type { DeferredRuntimeJob } from "@covel/shared";

describe("public orchestration guide", () => {
  it.each(["", "en/"])(
    "loads and commits the exact documented selectors and detached generator (%s)",
    async (edition) => {
      const files = async (prefix: string) => {
        const pages = await Promise.all(
          ["plugins/advanced.md", "reference/plugins.md"].map((page) =>
            readFile(
              path.resolve(
                import.meta.dirname,
                `../../../docs/${prefix}${page}`,
              ),
              "utf8",
            ),
          ),
        );
        return Object.fromEntries(
          [
            ...pages
              .join("\n")
              .matchAll(
                /<!-- presentation-file:([^ ]+) -->\s+```[^\n]+\n([\s\S]*?)\n```/g,
              ),
          ].map((match) => [match[1]!, match[2]!]),
        );
      };
      const documented = await files(edition);
      expect(documented).toEqual(await files(edition ? "" : "en/"));
      expect(Object.keys(documented)).toHaveLength(6);
      const root = await mkdtemp(path.join(tmpdir(), "presentation-guide-"));
      const f = await setup();
      const mediaStore = createMemoryMediaStore();
      try {
        for (const [file, content] of Object.entries(documented)) {
          await mkdir(path.dirname(path.join(root, file)), { recursive: true });
          await writeFile(path.join(root, file), content);
        }
        for (const id of ["gallery-display", "gallery-generator"]) {
          const report = await validatePluginPackage(path.join(root, id));
          expect(report.ok, JSON.stringify(report.issues)).toBe(true);
        }
        const loaded: Awaited<ReturnType<typeof loadRuntime>>[] = [];
        for (const discovery of await discoverPlugins(root)) {
          const definition = await loadPluginDefinition(discovery);
          for (const runtime of definition.manifests) {
            loaded.push(
              await loadRuntime(
                discovery,
                runtime.manifest.name,
                "en",
                definition,
              ),
            );
          }
        }
        expect(loaded).toHaveLength(2);
        for (const runtime of loaded)
          expect(runtime.handler).toBeTypeOf("function");
        const at = new Date().toISOString();
        await f.store.setPluginData({
          id: "art",
          sessionId: "session",
          pluginId: "gallery-display",
          namespace: "art",
          key: "Library",
          value: { caption: "Library art" },
          createdAt: at,
          updatedAt: at,
        });
        const calls: string[] = [];
        const gateway: PluginRuntimeGateway = {
          resolveSlot: () => ({
            presetId: "image",
            provider: "fixture",
            model: "image",
            protocol: "openai-chat-v1",
            tag: "image",
            metadata: {},
          }),
          generateText: async () => {
            throw new Error("Unexpected text generation");
          },
          generateObject: async () => {
            throw new Error("Unexpected object generation");
          },
          generateImage: async (request) => {
            calls.push(request.prompt);
            return {
              target: {
                provider: "fixture",
                model: "image",
                protocol: "openai-chat-v1",
                metadata: {},
              },
              images: [
                {
                  kind: "bytes",
                  bytes: new Uint8Array([1, 2]),
                  mime: "image/png",
                },
              ],
              warnings: [],
            };
          },
        };
        const deps = f.deps(
          {},
          {
            gateway,
            mediaStore,
            loadRuntime: async (manifest) =>
              loaded.find(
                (runtime) => runtime.manifest.name === manifest.name,
              ) ?? {
                manifest,
                promptTemplate: "",
                handler: async () => ({ outcome: "success", value: story }),
              },
          },
        );
        const manifests = [
          narrator,
          ...loaded.map((runtime) => runtime.manifest),
        ];
        const source = await executeTurn(input, manifests, deps);
        expect(calls).toHaveLength(0);
        expect(source.result.deferredRuntimeJobs).toHaveLength(1);
        let jobs: readonly DeferredRuntimeJob[] = [];
        const committed = await f.commit(source, {
          mediaStore,
          extraInTx: async (tx) => {
            jobs = await finalizePresentationJobs(
              tx,
              "session",
              source.result.deferredRuntimeJobs ?? [],
              manifests,
              true,
            );
          },
        });
        expect(committed.status).toBe("committed");
        expect((await f.store.listMessages("session"))[0]?.content).toContain(
          "The library is open.",
        );
        expect(
          (
            await f.store.getPluginData(
              "session",
              "gallery-display",
              "display",
              "current",
            )
          )?.value,
        ).toEqual({ scene: "Library", art: { caption: "Library art" } });
        const descriptor = jobs[0];
        expect(descriptor?.presentation?.committed).toBe(true);
        const generated = await executeTurn(
          {
            sessionId: "session",
            turnId: "generated",
            origin: "background",
            playerMessage: "",
            detachedStage: {
              ...descriptor!,
              turnDigest: emptyPresentationDigest(descriptor!.sourceTurnId),
            },
          },
          manifests,
          deps,
        );
        expect(generated.result.runtimeResults[0]?.status).toBe("success");
        expect((await f.commit(generated, { mediaStore })).status).toBe(
          "committed",
        );
        expect(calls).toEqual([JSON.stringify(story.segments)]);
        const row = await f.store.getPluginData(
          "session",
          "gallery-generator",
          "display",
          "current",
        );
        expect(row?.value).toMatchObject({
          art: { id: expect.any(String), mime: "image/png" },
        });
        expect(await mediaStore.listAssets()).toHaveLength(1);
        const terminal = (await f.store.listTraceEvents("session")).filter(
          (event) => event.type === "presentation.completed",
        );
        expect(terminal).toHaveLength(2);
        expect(terminal.map((event) => event.payload)).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              runtimeId: "gallery-display",
              status: "updated",
            }),
            expect.objectContaining({
              runtimeId: "gallery-generator/render",
              status: "updated",
              sourceTurnId: "source",
              budget: {
                calls: { limit: 1, used: 1 },
                generations: { limit: 1, used: 1 },
              },
            }),
          ]),
        );
      } finally {
        await f.store.close();
        await rm(root, { recursive: true, force: true });
      }
    },
  );
  it("loads and executes the documented community package with canonical actor schemas", async () => {
    const document = await readFile(
      path.resolve(import.meta.dirname, "../../../docs/plugins/advanced.md"),
      "utf8",
    );
    const english = await readFile(
      path.resolve(import.meta.dirname, "../../../docs/en/plugins/advanced.md"),
      "utf8",
    );
    const block = (text: string, name: string) => {
      const match = text.match(
        new RegExp(
          `<!-- orchestration-${name} -->\\s*\x60\x60\x60(?:yaml|js)\\n([\\s\\S]*?)\\n\x60\x60\x60`,
        ),
      );
      if (!match?.[1]) throw new Error(`Missing guide block: ${name}`);
      return match[1];
    };
    const root = await mkdtemp(path.join(tmpdir(), "orchestration-guide-"));
    const dir = path.join(root, "conversation");
    const files = {
      package: "PLUGIN.md",
      entry: "server/index.js",
      actor: "runtimes/actor/RUNTIME.md",
      story: "runtimes/story/RUNTIME.md",
      handler: "runtimes/story/handler.js",
    };
    const store = createMemoryStore();
    try {
      for (const [name, file] of Object.entries(files)) {
        expect(block(english, name)).toBe(block(document, name));
        await mkdir(path.dirname(path.join(dir, file)), { recursive: true });
        await writeFile(path.join(dir, file), block(document, name));
      }
      const [discovery] = await discoverPlugins(root);
      const definition = await loadPluginDefinition(discovery!);
      expect(definition.packageManifest.plugin.contributes?.services).toEqual([
        { contract: "turn-policy@1", modelFacing: true },
        { contract: "turn-policy@1", modelFacing: true },
      ]);
      provideHostModules(dir);
      const entry = (await import(
        pathToFileURL(path.join(dir, files.entry)).href
      )) as { default: (api: Pick<PluginAPI, "registerService">) => void };
      const services = new PluginServiceRegistry({
        list: async () => ["conversation"],
        ensure: async () => {},
      });
      entry.default({
        registerService: (service) =>
          services.register("conversation", service),
      });
      expect(services.list().map(({ name }) => name)).toEqual([
        "draw",
        "ensemble",
      ]);
      await store.createSession({
        id: "scene",
        status: "active",
        phase: "playing",
        locale: "en-US",
        seats: [],
        activePlugins: ["conversation"],
        setupRuntimes: {},
        completedPlayerTurns: 0,
        metadata: {
          orchestration: {
            turnPolicy: { pluginId: "conversation", name: "ensemble" },
          },
        },
        createdAt: "2026-01-01",
        updatedAt: "2026-01-01",
      });
      await store.upsertCharacter({
        id: "private-character",
        sessionId: "scene",
        name: "Mara",
        type: "npc",
        version: 1,
        createdAt: "2026-01-01",
        updatedAt: "2026-01-01",
      });
      const actor = await loadRuntime(discovery!, "conversation/actor");
      const story = await loadRuntime(discovery!, "conversation/story");
      const execution = await executeTurn(
        {
          sessionId: "scene",
          turnId: "turn",
          origin: "player",
          playerMessage: "Continue",
          locale: "en-US",
        },
        [actor.manifest, story.manifest],
        {
          store,
          services,
          llm: {
            generate: async () =>
              prose(
                JSON.stringify({
                  segments: [{ kind: "dialogue", text: "Welcome." }],
                  intent: "PRIVATE-GUIDE-INTENT",
                }),
              ),
          },
          loadRuntime: async (manifest) =>
            manifest.name === actor.manifest.name ? actor : story,
        },
      );
      expect(execution.result.runtimeResults[0]?.status).toBe("success");
      expect(
        (
          await commitExecution({
            store,
            execution,
            completion: { kind: "turn", turnId: "turn", durationMs: 0 },
          })
        ).status,
      ).toBe("committed");
      const messages = await store.listMessages("scene");
      expect(messages).toHaveLength(1);
      expect(messages[0]?.content).toContain("Welcome.");
      expect(JSON.stringify(messages)).not.toContain("PRIVATE-GUIDE-INTENT");
      expect(block(english, "agent")).toBe(block(document, "agent"));
      await writeFile(path.join(dir, files.story), block(document, "agent"));
      const agent = await loadRuntime(discovery!, "conversation/story");
      expect(agent.manifest.tools).toMatchObject({
        builtin: ["delegate", "delegate-batch"],
        services: [{ contract: "turn-policy@1", name: "choose-speakers" }],
      });
    } finally {
      await store.close();
      await rm(root, { recursive: true, force: true });
    }
  });
});
