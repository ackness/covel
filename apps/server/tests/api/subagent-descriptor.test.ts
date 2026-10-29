/**
 * A sub-agent-only runtime is described as one: the plugin detail and the
 * flow mark it `subagentOnly`, and the package gets no `ui:manual-action`
 * tag from it, so no surface offers it as a manual run.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { Hono } from "hono";
import { stringify } from "yaml";
import { createMemoryStore } from "@covel/store/memory";
import { createEventBus } from "@covel/events";
import type { PluginRegistry } from "@covel/plugin-loader";
import { pluginRoutes } from "../../src/routes/api/plugins.js";
import { discoverAndRegisterPlugins } from "../../src/routes/api/bootstrap/plugin-discovery.js";
import { buildPluginFlowResponse } from "../../src/routes/misc-api/plugin-flow.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  vi.restoreAllMocks();
});

async function fixture() {
  const dir = await mkdtemp(path.join(tmpdir(), "covel-subagent-desc-"));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  const root = path.join(dir, "gatehouse");
  const write = async (file: string, data: unknown, body = "") => {
    const target = path.join(root, file);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, `---\n${stringify(data)}---\n${body}`);
  };
  await write("PLUGIN.md", {
    id: "gatehouse",
    kind: "plugin",
    description: "Sub-agent descriptor fixture",
  });
  await write(
    "runtimes/guard/RUNTIME.md",
    {
      schedule: { subagentOnly: true },
      io: { output: { contract: "gatehouse-actor@1" } },
    },
    "You are the gate guard.\n",
  );
  await write(
    "runtimes/watch/RUNTIME.md",
    { schedule: { stage: "post-turn" } },
    "Watch the gate.\n",
  );
  const eventBus = createEventBus(createMemoryStore());
  cleanups.push(() => eventBus.close());
  vi.spyOn(console, "warn").mockImplementation(() => {});
  const { registry } = await discoverAndRegisterPlugins({
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
  return { app, registry };
}

describe("sub-agent-only runtime descriptors", () => {
  it("marks the runtime subagentOnly and offers no manual run", async () => {
    const { app, registry } = await fixture();
    const entry = registry.get("gatehouse");
    expect(entry?.packageManifest?.plugin.tags ?? []).not.toContain(
      "ui:manual-action",
    );

    const detail = (await (
      await app.request("/api/plugins/gatehouse")
    ).json()) as {
      runtimes: { id: string; subagentOnly?: true; trigger: unknown }[];
    };
    const guard = detail.runtimes.find((r) => r.id === "gatehouse/guard");
    const watch = detail.runtimes.find((r) => r.id === "gatehouse/watch");
    expect(guard).toMatchObject({
      subagentOnly: true,
      trigger: { type: "manual" },
    });
    expect(watch).not.toHaveProperty("subagentOnly");

    const flow = (await (await app.request("/api/plugin-flows")).json()) as {
      steps: { runtimeId: string; subagentOnly?: true }[];
    };
    expect(
      flow.steps.find((s) => s.runtimeId === "gatehouse/guard"),
    ).toMatchObject({ subagentOnly: true });
    expect(
      flow.steps.find((s) => s.runtimeId === "gatehouse/watch"),
    ).not.toHaveProperty("subagentOnly");
  });
});
