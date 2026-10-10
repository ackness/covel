import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPluginRegistry } from "@covel/plugin-loader";
import { type DataStore } from "@covel/store";
import { createMemoryStore } from "@covel/store/memory";
import { createSqliteStore } from "@covel/store/sqlite";
import { makeWorld } from "../../../../packages/store/src/contract/test-fixtures.js";
import {
  buildSessionHookScope,
  loadSessionHookScope,
} from "../../src/routes/api/session/hook-scope.js";

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
      plugin: {
        id: pluginId,
        kind: "plugin",
        description: "Hook-only package",
      },
      manifest: {
        name: pluginId,
        pluginId,
        description: "Hook-only package",
        pluginType: "plugin",
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
      packageManifest: {
        plugin: {
          id: pluginId,
          kind: "plugin",
          description: "Settings fixture",
        },
        manifest: {
          name: pluginId,
          pluginId,
          description: "Synthetic settings fixture",
          pluginType: "plugin",
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
        session: { activePlugins: [pluginId], worldId, locale: "en-US" },
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
  },
);
