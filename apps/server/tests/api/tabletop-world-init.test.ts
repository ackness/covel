import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { parse } from "yaml";
import { expect, it, vi } from "vitest";
import { createSqliteStore } from "@covel/store";
import type { LLMAdapter } from "@covel/runtime";
import {
  bootstrapApi,
  type ApiBootstrapResult,
} from "../../src/routes/api/bootstrap.js";
import {
  buildTabletopProbeZip,
  tabletopProbeId,
} from "../helpers/tabletop-package.js";

it("creates a third-party form from the real world-init guard in the first setup execution", async () => {
  const project = path.resolve(import.meta.dirname, "../../../..");
  const root = await mkdtemp(path.join(tmpdir(), "covel-tabletop-world-"));
  const user = path.join(root, "plugins");
  await mkdir(user);
  const store = createSqliteStore(path.join(root, "session.sqlite"));
  const generate = vi.fn<LLMAdapter["generate"]>(async () => ({
    content: "{}",
    toolCalls: [],
    finishReason: "stop",
    usage: { inputTokens: 1, outputTokens: 1 },
  }));
  let boot: ApiBootstrapResult | undefined;
  vi.stubEnv("COVEL_USER_PLUGINS_DIR", user);
  vi.stubEnv("NODE_ENV", "development");
  const start = () =>
    bootstrapApi({
      pluginsDir: path.join(project, "plugins"),
      pluginsDirs: [path.join(project, "plugins"), user],
      store,
      storeBackend: "sqlite",
      llmAdapter: { generate },
    });
  try {
    boot = await start();
    const upload = new FormData();
    upload.append(
      "file",
      new Blob([await buildTabletopProbeZip()]),
      "tabletop-probe.zip",
    );
    const installed = await boot.app.request("/api/install/plugin", {
      method: "POST",
      body: upload,
    });
    expect(installed.status, await installed.text()).toBe(201);
    boot.runtimeJobWorker.close();
    await boot.eventBus.flush();
    boot = await start();
    expect(boot.registry.get(tabletopProbeId)?.source).toBe("community");

    const world = parse(
      await readFile(path.join(project, "worlds/mistport/world.yaml"), "utf8"),
    );
    const now = new Date().toISOString();
    const sessionId = "tabletop-world";
    await store.upsertWorld({
      id: "mistport",
      name: "Mistport",
      description: "Declared world attributes",
      createdAt: now,
      metadata: { characterAttributes: world.characterAttributes },
    });
    await store.createSession({
      id: sessionId,
      worldId: "mistport",
      status: "active",
      phase: "setup",
      setupRuntimes: {},
      completedPlayerTurns: 0,
      activePlugins: ["world-init", tabletopProbeId],
      locale: "en-US",
      metadata: {
        approvalScopeNonce: crypto.randomUUID(),
        sessionIncarnationNonce: crypto.randomUUID(),
      },
      createdAt: now,
      updatedAt: now,
    });
    const requestId = crypto.randomUUID();
    for (let attempt = 0; attempt < 4; attempt++) {
      const response = await boot.app.request("/api/actions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          requestId,
          sessionId,
          type: "start_session",
          payload: {},
        }),
      });
      if (response.status === 202) {
        const pending = await response.json();
        const decision = await boot.app.request(
          `/api/approvals/${pending.approvalId}/decision`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ decision: "allow", scope: "session" }),
          },
        );
        expect(decision.status, await decision.text()).toBe(200);
        continue;
      }
      expect(response.status, await response.text()).toBe(200);
      break;
    }
    const turns = await store.listTurnResults(sessionId);
    expect(turns).toHaveLength(1);
    expect(turns[0]!.runtimeResults).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          runtimeId: "world-init/schema-gen",
          status: "skipped",
        }),
        expect.objectContaining({
          runtimeId: `${tabletopProbeId}/creation`,
          status: "success",
        }),
      ]),
    );
    const creation = turns[0]!.runtimeResults.find(
      (r) => r.runtimeId === `${tabletopProbeId}/creation`,
    )!;
    expect(creation.toolCalls.map((call) => call.toolName)).not.toContain(
      "get-character-schema",
    );
    const rules = await store.getPluginData(
      sessionId,
      tabletopProbeId,
      "setup",
      "rules",
    );
    expect(rules?.value).toMatchObject({
      budget: 4,
      attributes: expect.arrayContaining([
        expect.objectContaining({ id: "tideReading" }),
        expect.objectContaining({ id: "stealth" }),
        expect.objectContaining({ id: "diplomacy" }),
        expect.objectContaining({ id: "combat" }),
      ]),
    });
    const trace = await store.listTraceEvents(sessionId);
    expect(trace.filter((event) => event.type === "llm.calling")).toEqual([]);
  } finally {
    boot?.runtimeJobWorker.close();
    await boot?.eventBus.flush();
    await store.close();
    vi.unstubAllEnvs();
    await rm(root, { recursive: true, force: true });
  }
}, 30_000);
