import { mkdtemp, mkdir, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LLMAdapter } from "@covel/runtime";
import { createMemoryStore } from "@covel/store";
import {
  bootstrapApi,
  type ApiBootstrapResult,
} from "../../src/routes/api/bootstrap.js";
import { buildUiSpecsResponse } from "../../src/routes/misc-api/ui-specs.js";
import { buildThirdPartyPluginZip } from "../helpers/third-party-package.js";

const pluginId = "lifecycle-probe";
const sessionId = "fixture-session";
const token = "synthetic-install-token";
const auth = { Authorization: `Bearer ${token}` };
const sessionPath = `/api/sessions/${sessionId}`;

describe("standalone third-party plugin ZIP lifecycle", () => {
  let root: string;
  let builtinDir: string;
  let userDir: string;
  let boot: ApiBootstrapResult;
  let zip: Buffer;
  let store: ReturnType<typeof createMemoryStore>;
  const generate = vi.fn<LLMAdapter["generate"]>(async () => ({
    content: null,
    toolCalls: [
      {
        id: "fixture-tool-call",
        name: "lifecycle-probe-record",
        arguments: JSON.stringify({
          key: "agent",
          text: "Agent fixture record",
        }),
      },
    ],
    finishReason: "tool_calls",
    usage: { inputTokens: 10, outputTokens: 10 },
  }));

  async function restart() {
    boot?.runtimeJobWorker.close();
    boot = await bootstrapApi({
      pluginsDir: builtinDir,
      pluginsDirs: [builtinDir, userDir],
      store,
      storeBackend: "memory",
      llmAdapter: { generate },
    });
  }

  async function install(headers: Record<string, string> = auth) {
    const body = new FormData();
    body.append(
      "file",
      new Blob([zip], { type: "application/zip" }),
      "probe.zip",
    );
    return boot.app.request("/api/install/plugin", {
      method: "POST",
      headers,
      body,
    });
  }

  async function request(
    url: string,
    method: string,
    body?: unknown,
    headers = {},
  ) {
    return boot.app.request(url, {
      method,
      headers: { ...auth, "Content-Type": "application/json", ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  }

  async function allow(response: Response) {
    expect(response.status).toBe(202);
    const pending = await response.json();
    expect(pending.status).toBe("approval-required");
    const decision = await request(
      `/api/approvals/${pending.approvalId}/decision`,
      "POST",
      {
        decision: "allow",
        scope: "session",
      },
    );
    expect(decision.status, JSON.stringify(await decision.json())).toBe(200);
  }

  async function enable() {
    const url = `${sessionPath}/plugins/${pluginId}`;
    await allow(await request(url, "PUT"));
    expect((await request(url, "PUT")).status).toBe(200);
  }

  async function approvedRpc(body: unknown, headers = {}) {
    const send = () =>
      request(`${sessionPath}/plugin-rpc`, "POST", body, headers);
    const first = await send();
    const pending = await first.clone().json();
    if (pending.status !== "approval-required") return first;
    await allow(first);
    return send();
  }

  const runtimeBody = (name: string, payload = {}) => ({
    kind: "runtime",
    pluginId,
    runtimeId: `${pluginId}/${name}`,
    payload,
  });

  async function readNote(key: string) {
    const res = await request(
      `${sessionPath}/plugin-data/${pluginId}/notes/${key}`,
      "GET",
    );
    expect(res.status).toBe(200);
    return (await res.json()).value;
  }

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "covel-third-party-"));
    builtinDir = path.join(root, "builtin");
    userDir = path.join(root, "user");
    await mkdir(builtinDir);
    await mkdir(userDir);
    vi.stubEnv("COVEL_USER_PLUGINS_DIR", userDir);
    vi.stubEnv("COVEL_DESKTOP_REST_TOKEN", token);
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
    zip = await buildThirdPartyPluginZip();
    await restart();
  });

  afterEach(async () => {
    boot?.runtimeJobWorker.close();
    vi.unstubAllEnvs();
    await rm(root, { recursive: true, force: true });
  });

  it("installs, approves, exercises capabilities, disables, uninstalls and reinstalls", async () => {
    expect((await install({})).status).toBe(401);
    const installed = await install();
    expect(
      installed.status,
      JSON.stringify(await installed.clone().json()),
    ).toBe(201);
    expect(await installed.json()).toMatchObject({
      id: pluginId,
      restartRequired: true,
    });
    expect(boot.registry.get(pluginId)).toBeUndefined();
    const original = await readFile(
      path.join(userDir, pluginId, "server/index.js"),
      "utf8",
    );
    const duplicate = await install();
    expect(duplicate.status).toBe(409);
    expect(await readdir(userDir)).toEqual([pluginId]);
    expect(
      await readFile(path.join(userDir, pluginId, "server/index.js"), "utf8"),
    ).toBe(original);

    await restart();
    const entry = boot.registry.get(pluginId);
    expect(entry?.source).toBe("community");
    expect(entry?.status).toBe("registered");
    expect(entry?.manifests).toHaveLength(3);
    expect(entry?.loadedRuntimes.size).toBe(0);
    const details = await request(`/api/plugins/${pluginId}`, "GET");
    expect(details.status).toBe(200);
    expect(await details.text()).toContain("voice");
    await enable();

    const ui = await buildUiSpecsResponse({
      registry: boot.registry,
      store: boot.store,
      sessionId,
    });
    expect(ui.right).toEqual([expect.objectContaining({ pluginId })]);
    expect(JSON.stringify(ui)).toContain("lifecycle-probe-panel");
    const headers = {
      "X-Plugin-User-Settings": Buffer.from(
        JSON.stringify({
          [pluginId]: { label: "override", count: 3, voice: "detailed" },
        }),
      ).toString("base64"),
    };
    const note = await approvedRpc(runtimeBody("note"), headers);
    expect(note.status, JSON.stringify(await note.clone().json())).toBe(200);
    expect(await readNote("note")).toMatchObject({
      kind: "note",
      label: "override",
      count: 3,
    });
    expect(generate).not.toHaveBeenCalled();

    const agent = await approvedRpc(runtimeBody("agent"), headers);
    expect(agent.status, JSON.stringify(await agent.clone().json())).toBe(200);
    expect(await readNote("agent")).toMatchObject({
      kind: "agent",
      text: "Agent fixture record",
    });
    expect(generate).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(generate.mock.calls[0]?.[0].messages)).toContain(
      "Test style: detailed",
    );
    expect(
      generate.mock.calls[0]?.[0].tools?.map((tool) => tool.name),
    ).toContain("lifecycle-probe-record");

    const background = await approvedRpc(runtimeBody("background"));
    expect(background.status).toBe(202);
    const accepted = await background.json();
    expect(accepted).toMatchObject({
      status: "accepted",
      jobId: expect.any(String),
    });
    await vi.waitFor(async () => {
      expect(
        await boot.store.getPluginData(
          sessionId,
          pluginId,
          "_jobs",
          accepted.jobId,
        ),
      ).toMatchObject({ value: { status: "done" } });
    });
    expect(await readNote("background")).toMatchObject({ kind: "background" });

    const status = await approvedRpc({
      kind: "action",
      pluginId,
      action: "probe-status",
      payload: {},
    });
    expect(status.status, JSON.stringify(await status.clone().json())).toBe(
      200,
    );
    const statusBody = await status.json();
    expect(statusBody).toMatchObject({
      result: { pluginId, hookStarts: expect.any(Number) },
    });
    expect(statusBody.result.hookStarts).toBeGreaterThanOrEqual(3);

    const failed = await approvedRpc(
      runtimeBody("note", { key: "rollback", fail: true }),
    );
    expect(failed.status).toBe(200);
    expect(await failed.json()).toMatchObject({
      runtimeResults: [expect.objectContaining({ status: "failed" })],
    });
    expect(
      await boot.store.getPluginData(sessionId, pluginId, "notes", "rollback"),
    ).toBeNull();
    expect(await readNote("note")).toMatchObject({ label: "override" });

    expect(
      (await request(`${sessionPath}/plugins/${pluginId}`, "DELETE")).status,
    ).toBe(200);
    expect(
      (await request(`${sessionPath}/plugin-rpc`, "POST", runtimeBody("note")))
        .status,
    ).toBe(404);
    expect(
      (
        await buildUiSpecsResponse({
          registry: boot.registry,
          store: boot.store,
          sessionId,
        })
      ).right,
    ).toEqual([]);
    await enable();
    expect(
      (await request(`${sessionPath}/plugin-rpc`, "POST", runtimeBody("note")))
        .status,
    ).toBe(202);

    const removed = await request(`/api/plugins/${pluginId}`, "DELETE");
    expect(removed.status).toBe(200);
    expect(await removed.json()).toMatchObject({ restartRequired: true });
    expect(await readdir(userDir)).toEqual([]);
    await restart();
    expect(boot.registry.get(pluginId)).toBeUndefined();
    expect(
      (await request(`${sessionPath}/plugin-rpc`, "POST", runtimeBody("note")))
        .status,
    ).toBe(404);
    expect(
      await store.getPluginData(sessionId, pluginId, "notes", "note"),
    ).toMatchObject({ value: { label: "override" } });
    expect((await request(`/api/plugins/${pluginId}`, "DELETE")).status).toBe(
      404,
    );

    expect((await install()).status).toBe(201);
    await restart();
    expect(boot.registry.get(pluginId)?.source).toBe("community");
    await enable();
    expect(await readNote("note")).toMatchObject({ label: "override" });
  });
});
