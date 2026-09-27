import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPluginRegistry } from "@covel/plugin-loader";
import {
  createMemoryStore,
  createSqliteStore,
  type DataStore,
} from "@covel/store";
import {
  makeSession,
  makeWorld,
} from "../../../../packages/store/src/contract/test-fixtures.js";
import {
  buildSessionHookScope,
  loadSessionHookScope,
} from "../../src/routes/api/session/hook-scope.js";
import { createBootstrapMemorySystem } from "../../src/routes/api/bootstrap/memory.js";

it("resolves hook settings for an active package with no runtimes", () => {
  const pluginId = "entry-only";
  const registry = createPluginRegistry();
  registry.register({
    id: pluginId,
    source: "builtin",
    status: "registered",
    loadedRuntimes: new Map(),
    summary: {
      id: pluginId,
      name: pluginId,
      description: "Hook-only package",
      pluginType: "plugin",
      runtimeCount: 0,
    },
    manifests: [],
    packageManifest: {
      manifest: {
        name: pluginId,
        pluginId,
        description: "Hook-only package",
        userSettings: [
          { key: "budget", type: "number", label: "Budget", default: 10 },
        ],
      },
      promptTemplate: "",
      rawFrontmatter: {},
    },
  });
  const scope = buildSessionHookScope({
    pluginRegistry: registry,
    activePluginIds: [pluginId],
    userSettings: { [pluginId]: { budget: 4 } },
  });
  expect([...scope.activePluginIds]).toEqual([pluginId]);
  expect(scope.settings?.[pluginId]).toEqual({ budget: 4 });
  expect(Object.isFrozen(scope.settings?.[pluginId])).toBe(true);
  expect(
    buildSessionHookScope({
      pluginRegistry: registry,
      activePluginIds: [],
    }).settings?.[pluginId],
  ).toBeUndefined();
});

describe.each(["memory", "sqlite"])(
  "world settings freshness on %s",
  (backend) => {
    let stores: DataStore[];
    let worldId: string;
    const pluginId = "configured";
    const registry = createPluginRegistry();
    registry.register({
      id: pluginId,
      source: "builtin",
      status: "registered",
      loadedRuntimes: new Map(),
      summary: {
        id: pluginId,
        name: "Configured",
        description: "Synthetic settings fixture",
        pluginType: "plugin",
        runtimeCount: 1,
      },
      manifest: {
        manifest: {
          name: pluginId,
          pluginId,
          description: "Synthetic settings fixture",
          runtimeType: "function",
          userSettings: [
            { key: "tone", type: "text", label: "Tone", default: "default" },
          ],
        },
        promptTemplate: "",
        rawFrontmatter: {},
      },
    });

    beforeEach(() => {
      stores = [0, 1].map(() =>
        backend === "sqlite"
          ? createSqliteStore(":memory:")
          : createMemoryStore(),
      );
      worldId = `settings-${crypto.randomUUID()}`;
    });
    afterEach(async () => {
      vi.restoreAllMocks();
      await Promise.all(stores.map((store) => store.close()));
    });

    function world(tone: string) {
      return makeWorld({
        id: worldId,
        metadata: { pluginSettings: { [pluginId]: { tone } } },
      });
    }
    const scope = (store: DataStore) =>
      loadSessionHookScope({
        store,
        pluginRegistry: registry,
        session: { activePlugins: [pluginId], worldId },
      });
    const tone = async (store: DataStore) =>
      (await scope(store)).settings?.[pluginId]?.tone;

    it("isolates same-id worlds owned by different stores", async () => {
      await stores[0]!.upsertWorld(world("first"));
      await stores[1]!.upsertWorld(world("second"));
      expect(await tone(stores[0]!)).toBe("first");
      expect(await tone(stores[1]!)).toBe("second");
    });

    it("uses committed edits for the next operation while preserving captured settings", async () => {
      const store = stores[0]!;
      await store.upsertWorld(world("before"));
      const captured = await scope(store);
      await store.upsertWorld(world("after"));
      expect(await tone(store)).toBe("after");
      expect(captured.settings?.[pluginId]?.tone).toBe("before");
    });

    it("does not pin a missing world across later creation", async () => {
      const store = stores[0]!;
      expect(await tone(store)).toBe("default");
      await store.upsertWorld(world("created"));
      expect(await tone(store)).toBe("created");
    });

    it("drops deleted world settings and reads a same-id replacement", async () => {
      const store = stores[0]!;
      await store.upsertWorld(world("before"));
      expect(await tone(store)).toBe("before");
      await store.deleteWorld(worldId);
      expect(await tone(store)).toBe("default");
      await store.createWorld(world("replacement"));
      expect(await tone(store)).toBe("replacement");
    });

    it("does not conceal a later settings read failure behind a previous result", async () => {
      const store = stores[0]!;
      await store.upsertWorld(world("before"));
      expect(await tone(store)).toBe("before");
      vi.spyOn(store, "getWorld").mockRejectedValueOnce(
        new Error("Synthetic read failure"),
      );
      await expect(scope(store)).rejects.toThrow("Synthetic read failure");
      expect(await tone(store)).toBe("before");
    });

    it("refreshes memory schemas per operation and keeps bootstrap stores isolated", async () => {
      vi.spyOn(console, "log").mockImplementation(() => {});
      const withBlock = (label: string) =>
        makeWorld({
          id: worldId,
          metadata: {
            memoryBlocks: [
              {
                label,
                displayName: label,
                icon: "Info",
                extractionHint: "Synthetic hint",
              },
            ],
          },
        });
      const managers = stores.map(
        (store) =>
          createBootstrapMemorySystem({
            store,
            manifestCache: new Map(),
            llmAdapter: {
              generate: async () => {
                throw new Error("Unexpected LLM call");
              },
            },
            preferredMemorySlot: "memory",
            resolveModel: () => "synthetic",
          })!.memorySystem.manager,
      );
      for (const store of stores) {
        await store.createSession(makeSession({ id: "session", worldId }));
      }
      await stores[0]!.upsertWorld(withBlock("clues"));
      await stores[1]!.upsertWorld(withBlock("suspects"));
      const labels = async (index: number) =>
        (await managers[index]!.loadBlocks("session")).map(
          (block) => block.label,
        );
      expect(await labels(0)).toContain("clues");
      expect(await labels(1)).toContain("suspects");
      expect(await labels(1)).not.toContain("clues");
      await stores[0]!.upsertWorld(withBlock("evidence"));
      expect(await labels(0)).toContain("evidence");
      expect(await labels(0)).not.toContain("clues");
      await stores[0]!.deleteWorld(worldId);
      expect(await labels(0)).not.toContain("evidence");
    });
  },
);
