import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { Hono } from "hono";
import { stringify } from "yaml";
import { createMemoryStore } from "@covel/store/memory";
import { createEventBus } from "@covel/events";
import type { PluginRegistry } from "@covel/plugin-loader";
import { apiListResponseSchema, pluginSummarySchema } from "@covel/shared";
import { pluginRoutes } from "../../src/routes/api/plugins.js";
import { discoverAndRegisterPlugins } from "../../src/routes/api/bootstrap/plugin-discovery.js";
import { preparePluginReload } from "../../src/routes/api/bootstrap/plugin-reload.js";
import { buildPluginFlowResponse } from "../../src/routes/misc-api/plugin-flow.js";
import { buildAvailablePluginList } from "../../src/routes/api/session/plugins.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  vi.restoreAllMocks();
});

async function fixture(multi: boolean, warnings = true) {
  const dir = await mkdtemp(path.join(tmpdir(), "covel-load-diagnostics-"));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  const root = path.join(dir, "partial");
  const writeManifest = async (file: string, data: unknown) => {
    const target = path.join(root, file);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, `---\n${stringify(data)}---\n`);
  };
  const update = async (hasWarnings: boolean) => {
    const runtime = {
      ...(hasWarnings ? {} : { schedule: { stage: "post-turn" } }),
      io: { output: { contract: "partial-output@1" } },
    };
    await writeManifest("PLUGIN.md", {
      id: "partial",
      kind: "plugin",
      description: "Plugin load diagnostic fixture",
      provides: ["partial-output@1"],
      ...(hasWarnings ? { futureFeature: true } : {}),
      ...(multi ? {} : { runtime }),
    });
    if (multi) {
      await writeManifest("runtimes/broken/RUNTIME.md", runtime);
      await writeManifest("runtimes/healthy/RUNTIME.md", {
        schedule: { stage: "post-turn" },
        ...(hasWarnings ? { futureRuntimeFeature: true } : {}),
      });
    }
  };
  await update(warnings);
  const eventBus = createEventBus(createMemoryStore());
  cleanups.push(() => eventBus.close());
  vi.spyOn(console, "warn").mockImplementation(() => {});
  const { registry, discoveryMap } = await discoverAndRegisterPlugins({
    pluginsDir: dir,
    eventBus,
  });
  const app = new Hono<{ Variables: { pluginRegistry: PluginRegistry } }>();
  app.use("*", async (c, next) => {
    c.set("pluginRegistry", registry);
    await next();
  });
  app.route("/api/plugins", pluginRoutes);
  app.get("/api/plugin-flows", (c) =>
    c.json(buildPluginFlowResponse(registry)),
  );
  const summary = async () => {
    const response = await app.request("/api/plugins");
    expect(response.status).toBe(200);
    const payload = await response.json();
    expect(JSON.stringify(payload)).not.toContain(dir);
    const { items } = apiListResponseSchema(pluginSummarySchema).parse(payload);
    expect(items).toHaveLength(1);
    return items[0]!;
  };
  return { app, registry, discoveryMap, update, summary, root };
}

describe("public plugin load diagnostics", () => {
  it.each([false, true])(
    "keeps partial-load warnings across API projections (multi=%s)",
    async (multi) => {
      const { app, summary, registry, root } = await fixture(multi);
      const plugin = await summary();
      const sourcePath = multi ? "runtimes/broken/RUNTIME.md" : "PLUGIN.md";
      expect(plugin.hostState).toBe("installed");
      expect(plugin.error).toBeUndefined();
      expect(plugin.runtimeCount).toBe(multi ? 1 : 0);
      expect(plugin.provides).toEqual([]);
      expect(plugin.disabledRuntimes).toEqual([
        {
          sourcePath,
          message: expect.stringContaining(
            `${sourcePath}: ${multi ? "" : "runtime."}schedule.stage:`,
          ),
          outputContract: "partial-output@1",
        },
      ]);
      expect(
        plugin.ignoredFields?.map(({ sourcePath, field }) => ({
          sourcePath,
          field,
        })),
      ).toEqual([
        { sourcePath: "PLUGIN.md", field: "futureFeature" },
        ...(multi
          ? [
              {
                sourcePath: "runtimes/healthy/RUNTIME.md",
                field: "futureRuntimeFeature",
              },
            ]
          : []),
      ]);
      expect(plugin.ignoredFields?.[0]?.message).toBe(
        "PLUGIN.md: futureFeature: unknown field",
      );
      // Projection must not mutate the private diagnostics used by the loader.
      expect(registry.get("partial")?.disabledRuntimes?.[0]?.sourcePath).toBe(
        path.join(root, sourcePath),
      );

      const detail = await (await app.request("/api/plugins/partial")).json();
      const flow = await (await app.request("/api/plugin-flows")).json();
      const session = buildAvailablePluginList(["partial"], registry)[0];
      for (const projection of [detail, flow.plugins[0], session]) {
        expect(projection).toMatchObject({
          disabledRuntimes: plugin.disabledRuntimes,
          ignoredFields: plugin.ignoredFields,
        });
        expect(JSON.stringify(projection)).not.toContain(root);
      }
      expect(
        flow.steps.map((step: { runtimeId: string }) => step.runtimeId),
      ).toEqual(multi ? ["partial/healthy"] : []);
    },
  );

  it("refreshes warnings on reload and removes them once the manifests are corrected", async () => {
    const { summary, registry, discoveryMap, update } = await fixture(
      true,
      false,
    );
    const discovery = discoveryMap.get("partial");
    if (!discovery) throw new Error("Fixture plugin was not discovered");
    for (const hasWarnings of [true, false]) {
      await update(hasWarnings);
      const prepared = await preparePluginReload(discovery, [
        ...registry.getAll().values(),
      ]);
      registry.register(prepared.entry);
      const plugin = await summary();
      expect(plugin.disabledRuntimes?.length ?? 0).toBe(hasWarnings ? 1 : 0);
      expect(plugin.ignoredFields?.length ?? 0).toBe(hasWarnings ? 2 : 0);
      expect(plugin.runtimeCount).toBe(hasWarnings ? 1 : 2);
    }
  });

  it("omits warnings for a healthy plugin", async () => {
    const { summary } = await fixture(false, false);
    const plugin = await summary();
    expect(plugin.runtimeCount).toBe(1);
    expect(plugin).not.toHaveProperty("disabledRuntimes");
    expect(plugin).not.toHaveProperty("ignoredFields");
  });
});
