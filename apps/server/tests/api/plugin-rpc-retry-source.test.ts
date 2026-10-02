import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RuntimeResult } from "@covel/shared";
import { createMemoryStore } from "@covel/store/memory";
import {
  bootstrapApi,
  type ApiBootstrapResult,
} from "../../src/routes/api/bootstrap.js";
import { closeTestApi } from "../helpers/close-api.js";

const pluginId = "retry-probe";
const sessionId = "retry-source-session";
const sourceTurnId = "source-turn";

const upstreamResult: RuntimeResult = {
  pluginId,
  runtimeId: `${pluginId}/source`,
  runId: "source-run",
  turnId: sourceTurnId,
  status: "success",
  output: { text: "rolled-back upstream output" },
  canonicalValue: { value: { text: "rolled-back upstream output" } },
  toolCalls: [],
  durationMs: 1,
  timestamp: "2026-10-02T00:00:00.000Z",
};

async function writePlugin(root: string): Promise<void> {
  const dir = join(root, pluginId);
  await mkdir(join(dir, "runtimes", "source"), { recursive: true });
  await mkdir(join(dir, "runtimes", "consumer"), { recursive: true });
  await writeFile(
    join(dir, "package.json"),
    JSON.stringify({ name: pluginId, version: "1.0.0", type: "module" }),
  );
  await writeFile(
    join(dir, "PLUGIN.md"),
    `---
id: ${pluginId}
kind: plugin
description: Retry source commit fixture
version: 1.0.0
---
`,
  );
  await writeFile(
    join(dir, "runtimes", "source", "RUNTIME.md"),
    `---
type: function
description: Upstream producer
schedule:
  stage: narrative
  trigger:
    type: auto
function:
  handler: ../../source.js
---
`,
  );
  await writeFile(
    join(dir, "runtimes", "consumer", "RUNTIME.md"),
    `---
type: function
description: Downstream consumer gated on the upstream
schedule:
  stage: post-turn
  trigger:
    type: auto
  needs:
    - ${pluginId}/source
function:
  handler: ../../consumer.js
---
`,
  );
  await writeFile(
    join(dir, "source.js"),
    `export default async () => ({ outcome: "success", value: { text: "fresh" } });`,
  );
  await writeFile(
    join(dir, "consumer.js"),
    `export default async () => ({
      outcome: "success",
      value: {},
      effects: { pluginData: [{ namespace: "results", key: "ran", value: true }] },
    });`,
  );
}

describe("plugin-rpc retry source commit gate", () => {
  let root: string;
  let boot: ApiBootstrapResult | undefined;
  let store: ReturnType<typeof createMemoryStore>;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "covel-retry-source-"));
    await writePlugin(join(root, "plugins"));
    store = createMemoryStore();
    const now = new Date().toISOString();
    await store.createSession({
      id: sessionId,
      worldId: null,
      status: "active",
      phase: "playing",
      locale: "en-US",
      completedPlayerTurns: 1,
      setupRuntimes: {},
      activePlugins: [pluginId],
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

  async function seedSource(commitStatus: "committed" | "failed") {
    await store.saveTurnResult({
      id: crypto.randomUUID(),
      sessionId,
      turnId: sourceTurnId,
      runtimeResults: [upstreamResult],
      origin: "player",
      commitStatus,
      durationMs: 1,
      createdAt: upstreamResult.timestamp!,
    });
  }

  const retryConsumer = () =>
    boot!.app.request(`/api/sessions/${sessionId}/plugin-rpc`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        kind: "runtime",
        pluginId,
        runtimeId: `${pluginId}/consumer`,
        payload: {},
        retryFromTurnId: sourceTurnId,
      }),
    });

  it("refuses to run a downstream retry against a rolled-back source turn", async () => {
    await seedSource("failed");

    const response = await retryConsumer();

    expect(response.status, await response.clone().text()).toBe(409);
    expect(await response.json()).toMatchObject({
      code: "retry_source_not_committed",
    });
    expect(
      await store.getPluginData(sessionId, pluginId, "results", "ran"),
    ).toBeNull();
  });

  it("runs the downstream retry once the source turn committed", async () => {
    await seedSource("committed");

    const response = await retryConsumer();

    expect(response.status, await response.clone().text()).toBe(200);
    expect(
      (await store.getPluginData(sessionId, pluginId, "results", "ran"))?.value,
    ).toBe(true);
  });
});
