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
} from "@covel/plugin-loader";
import type { PluginAPI } from "@covel/plugin-handlers-utils";
import { createMemoryStore } from "@covel/store/memory";
import { PluginServiceRegistry } from "../src/plugin-services.js";
import { executeTurn, commitExecution } from "../src/index.js";
import { prose } from "./_helpers/agent-loop-fixture.js";

describe("public orchestration guide", () => {
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
        builtin: ["delegate"],
        services: [{ contract: "turn-policy@1", name: "choose-speakers" }],
      });
    } finally {
      await store.close();
      await rm(root, { recursive: true, force: true });
    }
  });
});
