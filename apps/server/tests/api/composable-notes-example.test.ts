import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMemoryStore } from "@covel/store";
import type { LLMAdapter } from "@covel/runtime";
import {
  bootstrapApi,
  type ApiBootstrapResult,
} from "../../src/routes/api/bootstrap.js";
import { buildUiSpecsResponse } from "../../src/routes/misc-api/ui-specs.js";
import { closeTestApi } from "../helpers/close-api.js";
import {
  buildNotesExampleZip,
  notesExampleIds,
} from "../helpers/notes-example-package.js";

const pluginId = "notes-workbench";
const sessionId = "notes-example-session";
const base = `/api/sessions/${sessionId}`;
const auth = { Authorization: "Bearer synthetic-notes-test-token" };

describe("installable composable notes example", () => {
  let root: string;
  let builtinDir: string;
  let userDir: string;
  let boot: ApiBootstrapResult;
  let store: ReturnType<typeof createMemoryStore>;
  const generate = vi.fn<LLMAdapter["generate"]>(async () => {
    throw new Error("Notes must never call an LLM");
  });

  async function restart() {
    await closeTestApi(boot);
    boot = await bootstrapApi({
      pluginsDir: builtinDir,
      pluginsDirs: [builtinDir, userDir],
      store,
      storeBackend: "memory",
      llmAdapter: { generate },
    });
  }
  function request(url: string, method = "GET", body?: unknown) {
    return boot.app.request(url, {
      method,
      headers: { ...auth, "Content-Type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  }
  async function approved(url: string, method: string, body?: unknown) {
    let response = await request(url, method, body);
    if (response.status === 202) {
      const pending = await response.clone().json();
      expect(pending.status).toBe("approval-required");
      const decision = await request(
        `/api/approvals/${pending.approvalId}/decision`,
        "POST",
        { decision: "allow", scope: "session" },
      );
      expect(decision.status).toBe(200);
      response = await request(url, method, body);
    }
    return response;
  }
  async function enable(id: string) {
    expect((await approved(`${base}/plugins/${id}`, "PUT")).status).toBe(200);
  }
  async function runtime(name: string, payload = {}) {
    const response = await approved(`${base}/plugin-rpc`, "POST", {
      kind: "runtime",
      pluginId,
      runtimeId: `${pluginId}/${name}`,
      payload,
    });
    expect(response.status, await response.clone().text()).toBe(200);
    const result = await response.json();
    return result.runtimeResults.find(
      (item: { runtimeId: string }) => item.runtimeId === `${pluginId}/${name}`,
    );
  }

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "covel-notes-example-"));
    builtinDir = path.join(root, "builtin");
    userDir = path.join(root, "user");
    await mkdir(builtinDir);
    await mkdir(userDir);
    vi.stubEnv("COVEL_USER_PLUGINS_DIR", userDir);
    vi.stubEnv("COVEL_DESKTOP_REST_TOKEN", "synthetic-notes-test-token");
    vi.stubEnv("NODE_ENV", "production");
    generate.mockClear();
    store = createMemoryStore();
    const now = new Date().toISOString();
    await store.createSession({
      id: sessionId,
      phase: "playing",
      setupRuntimes: {},
      worldId: null,
      status: "active",
      completedPlayerTurns: 0,
      activePlugins: [],
      locale: "en-US",
      metadata: {
        approvalScopeNonce: crypto.randomUUID(),
        sessionIncarnationNonce: crypto.randomUUID(),
      },
      createdAt: now,
      updatedAt: now,
    });
    await restart();
    for (const id of notesExampleIds) {
      const body = new FormData();
      body.append(
        "file",
        new Blob([await buildNotesExampleZip(id)], { type: "application/zip" }),
        `${id}.zip`,
      );
      const installed = await boot.app.request("/api/install/plugin", {
        method: "POST",
        headers: auth,
        body,
      });
      expect(installed.status, await installed.clone().text()).toBe(201);
    }
    await restart();
  });
  afterEach(async () => {
    await closeTestApi(boot);
    vi.unstubAllEnvs();
    await rm(root, { recursive: true, force: true });
  });

  it("installs independent packages, discovers approved providers, saves and switches without an LLM", async () => {
    for (const id of notesExampleIds)
      expect(boot.registry.get(id)?.source).toBe("community");
    expect(boot.registry.get("note-format-clean")?.manifests).toHaveLength(0);
    expect(boot.registry.get("note-format-outline")?.manifests).toHaveLength(0);
    await enable(pluginId);
    const commands = await request(`${base}/plugins`);
    expect(commands.status).toBe(200);
    const directory = await commands.json();
    const notesCommand = directory.commands.find(
      (item: { name: string }) => item.name === "notes",
    );
    expect(notesCommand).toBeDefined();
    const command = await approved(`${base}/plugin-rpc`, "POST", {
      kind: "command",
      commandId: notesCommand.id,
      input: "/notes",
    });
    expect(command.status).toBe(200);
    expect(await command.json()).toMatchObject({
      status: "ok",
      result: {
        clientAction: { type: "open-plugin-panel", panelId: pluginId },
      },
    });
    const ui = await buildUiSpecsResponse({
      registry: boot.registry,
      store,
      sessionId,
    });
    expect(JSON.stringify(ui.right)).toContain("Notes Workbench");
    expect((await runtime("providers")).output.providers).toEqual([]);

    const raw = await runtime("save", { text: "  Original note  " });
    expect(raw).toMatchObject({
      status: "success",
      output: { note: { text: "  Original note  ", providerPluginId: null } },
    });
    await enable("note-format-clean");
    await enable("note-format-outline");
    const discovered = await runtime("providers");
    expect(
      discovered.output.providers.map(
        (provider: { pluginId: string }) => provider.pluginId,
      ),
    ).toEqual(["note-format-clean", "note-format-outline"]);

    const text = "  First line  \r\n\r\n\r\nSecond line  ";
    const cleaned = await runtime("save", {
      text,
      providerPluginId: "note-format-clean",
    });
    expect(cleaned).toMatchObject({
      status: "success",
      output: {
        note: {
          originalText: text,
          text: "First line\n\nSecond line",
          providerPluginId: "note-format-clean",
        },
      },
    });
    const outline = await runtime("save", {
      text,
      providerPluginId: "note-format-outline",
    });
    expect(outline).toMatchObject({
      status: "success",
      output: {
        note: {
          text: "- First line\n- Second line",
          providerPluginId: "note-format-outline",
        },
      },
    });
    const notes = await store.listPluginData(sessionId, pluginId, "notes");
    expect(notes).toHaveLength(3);
    expect(new Set(notes.map((note) => note.key)).size).toBe(3);
    for (const id of ["note-format-clean", "note-format-outline"]) {
      expect(await store.listPluginData(sessionId, id, "notes")).toEqual([]);
    }
    const diagnostics = await request(
      `${base}/plugin-diagnostics?pluginId=notes-workbench`,
    );
    const history = await diagnostics.json();
    expect(history.calls).toHaveLength(2);
    expect(history.calls).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          callerPluginId: pluginId,
          providerPluginId: "note-format-clean",
          outcome: "success",
        }),
        expect.objectContaining({
          callerPluginId: pluginId,
          providerPluginId: "note-format-outline",
          outcome: "success",
        }),
      ]),
    );
    expect(JSON.stringify(history)).not.toContain("First line");

    expect(
      (await request(`${base}/plugins/note-format-outline`, "DELETE")).status,
    ).toBe(200);
    expect((await runtime("providers")).output.providers).toHaveLength(1);
    const failed = await runtime("save", {
      text: "Do not silently save",
      providerPluginId: "note-format-outline",
    });
    expect(failed.status).toBe("failed");
    expect(
      await store.listPluginData(sessionId, pluginId, "notes"),
    ).toHaveLength(3);
    expect((await runtime("save", { text: "   " })).status).toBe("failed");
    expect(
      await store.listPluginData(sessionId, pluginId, "notes"),
    ).toHaveLength(3);
    expect((await store.getSession(sessionId))?.completedPlayerTurns).toBe(0);
    expect(generate).not.toHaveBeenCalled();
  });
});
