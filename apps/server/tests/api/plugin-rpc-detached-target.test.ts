import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMemoryStore } from "@covel/store/memory";
import {
  bootstrapApi,
  type ApiBootstrapResult,
} from "../../src/routes/api/bootstrap.js";
import { closeTestApi } from "../helpers/close-api.js";

// A manual run of a scheduler-detached runtime defers the runtime instead of
// running it inline. The commit that ends the manual run must queue that job;
// dropping it would answer "ok" for work that never runs.
const pluginId = "manual-detached-probe";
const backgroundPluginId = "manual-detached-background-probe";
const sessionId = "manual-detached-session";

async function writePlugin(
  root: string,
  pluginId: string,
  background: boolean,
): Promise<void> {
  const dir = join(root, pluginId);
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, "package.json"),
    JSON.stringify({ name: pluginId, version: "1.0.0", type: "module" }),
  );
  await writeFile(
    join(dir, "PLUGIN.md"),
    `---
id: ${pluginId}
kind: plugin
description: Detached post-turn runtime triggered manually
version: 1.0.0
runtime:
  schedule:
    stage: post-turn
    trigger:
      type: auto
    detached: true${background ? "\n    background: true" : ""}
  function:
    handler: ./handler.js
  effects:
    writes:
      - plugin-data:self:results
---
`,
  );
  await writeFile(
    join(dir, "handler.js"),
    `export default async () => ({
      outcome: "success",
      value: {},
      effects: { pluginData: [{ namespace: "results", key: "ran", value: true }] },
    });`,
  );
}

describe("plugin-rpc manual run of a detached runtime", () => {
  let root: string;
  let boot: ApiBootstrapResult | undefined;
  let store: ReturnType<typeof createMemoryStore>;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "covel-manual-detached-"));
    await writePlugin(join(root, "plugins"), pluginId, false);
    await writePlugin(join(root, "plugins"), backgroundPluginId, true);
    store = createMemoryStore();
    const now = new Date().toISOString();
    await store.createSession({
      id: sessionId,
      status: "active",
      phase: "playing",
      locale: "en-US",
      completedPlayerTurns: 1,
      setupRuntimes: {},
      seats: [
        { id: "main", controller: "human", role: "player", characters: "auto" },
      ],
      activePlugins: [pluginId, backgroundPluginId],
      metadata: {
        approvalScopeNonce: "approval",
        sessionIncarnationNonce: "incarnation",
      },
      createdAt: now,
      updatedAt: now,
    });
    boot = await bootstrapApi({
      pluginsDir: join(root, "plugins"),
      covelHome: join(root, "home"),
      worldsDirs: [],
      store,
      storeBackend: "memory",
      // The function runtime needs no model: server services may run its job.
      canRunRuntimeJobWithServerServices: () => true,
      llmAdapter: {
        generate: async () => {
          throw new Error("unexpected agent generation");
        },
      },
    });
  });

  afterEach(async () => {
    await closeTestApi(boot);
    boot = undefined;
    await rm(root, { recursive: true, force: true });
  });

  const ran = async (id: string) =>
    (await store.getPluginData(sessionId, id, "results", "ran"))?.value;

  const runManually = (id: string) =>
    boot!.app.request(`/api/sessions/${sessionId}/plugin-rpc`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        kind: "runtime",
        pluginId: id,
        runtimeId: id,
        payload: {},
      }),
    });

  it("queues the deferred stage job in a sync run's commit", async () => {
    const response = await runManually(pluginId);

    expect(response.status, await response.clone().text()).toBe(200);
    const body = (await response.json()) as {
      readonly runtimeResults: readonly unknown[];
      readonly deferredJobs?: readonly {
        readonly jobId: string;
        readonly runtimeId: string;
      }[];
    };
    // The target was deferred, not run inline.
    expect(body.runtimeResults).toEqual([]);
    expect(body.deferredJobs).toEqual([
      { jobId: expect.any(String), runtimeId: pluginId },
    ]);
    const jobs = await store.listPluginData(
      sessionId,
      pluginId,
      "_runtime_jobs",
    );
    expect(jobs.map((row) => row.value)).toEqual([
      expect.objectContaining({
        jobId: body.deferredJobs?.[0]?.jobId,
        runtimeId: pluginId,
      }),
    ]);
    await vi.waitFor(async () => expect(await ran(pluginId)).toBe(true));
  });

  it("queues the deferred stage job in a background run's commit", async () => {
    const response = await runManually(backgroundPluginId);

    expect(response.status, await response.clone().text()).toBe(202);
    // The activation job commits the deferral; the stage job it queued runs.
    await vi.waitFor(async () =>
      expect(await ran(backgroundPluginId)).toBe(true),
    );
    const jobs = (
      await store.listPluginData(sessionId, backgroundPluginId, "_runtime_jobs")
    ).map((row) => row.value as { origin: { activation: string } });
    expect(jobs.map((job) => job.origin.activation).sort()).toEqual([
      "manual",
      "stage",
    ]);
  });
});
