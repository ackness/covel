import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LLMAdapter } from "@covel/runtime";
import { createMemoryStore } from "@covel/store";
import {
  bootstrapApi,
  type ApiBootstrapResult,
} from "../../src/routes/api/bootstrap.js";
import { buildThirdPartyPluginZip } from "../helpers/third-party-package.js";

const pluginId = "lifecycle-probe";
const sessionId = "external-session";
const auth = {
  Authorization: "Bearer synthetic-probe-token",
  "Content-Type": "application/json",
};
const sessionPath = `/api/sessions/${sessionId}`;

describe("runtime contracts through an installed community package", () => {
  let root: string;
  let boot: ApiBootstrapResult;
  let store: ReturnType<typeof createMemoryStore>;
  let mode: "prose" | "cards" | "noop" | "record";
  const generate = vi.fn<LLMAdapter["generate"]>(async () => ({
    content:
      mode === "prose"
        ? '{"updated":true,"prompts":["Inspect the door"]}'
        : null,
    toolCalls:
      mode === "prose"
        ? []
        : [
            {
              id: crypto.randomUUID(),
              name:
                mode === "noop"
                  ? "runtime-done"
                  : mode === "cards"
                    ? "lifecycle-probe-cards"
                    : "lifecycle-probe-record",
              arguments: JSON.stringify(
                mode === "noop"
                  ? {}
                  : mode === "cards"
                    ? { text: "Inspect the door" }
                    : { key: "agent", text: "Verified write" },
              ),
            },
          ],
    finishReason: mode === "prose" ? "stop" : "tool_calls",
    usage: { inputTokens: 10, outputTokens: 10 },
  }));

  async function restart() {
    boot?.runtimeJobWorker.close();
    boot = await bootstrapApi({
      pluginsDir: path.join(root, "builtin"),
      pluginsDirs: [path.join(root, "builtin"), path.join(root, "user")],
      store,
      storeBackend: "memory",
      llmAdapter: { generate },
    });
  }

  async function request(url: string, method = "GET", body?: unknown) {
    return boot.app.request(url, {
      method,
      headers: auth,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  }

  async function approved(url: string, method: string, body?: unknown) {
    for (let attempt = 0; attempt < 10; attempt++) {
      const response = await request(url, method, body);
      if (response.status !== 202) return response;
      const pending = await response.clone().json();
      if (pending.status !== "approval-required") return response;
      const decision = await request(
        `/api/approvals/${pending.approvalId}/decision`,
        "POST",
        { decision: "allow", scope: "session" },
      );
      expect(decision.status, await decision.text()).toBe(200);
    }
    throw new Error("Approval did not settle");
  }

  async function action(type: string, payload: Record<string, unknown>) {
    const response = await approved("/api/actions", "POST", {
      requestId: crypto.randomUUID(),
      sessionId,
      type,
      payload,
    });
    const text = await response.text();
    expect(response.status, text).toBe(200);
    return text
      .split("\n")
      .filter((line) => line.startsWith("data: "))
      .map((line) => JSON.parse(line.slice(6)));
  }

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "covel-contract-probe-"));
    await mkdir(path.join(root, "builtin"));
    await mkdir(path.join(root, "user"));
    vi.stubEnv("COVEL_USER_PLUGINS_DIR", path.join(root, "user"));
    vi.stubEnv("COVEL_DESKTOP_REST_TOKEN", "synthetic-probe-token");
    vi.stubEnv("NODE_ENV", "production");
    mode = "prose";
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
    const upload = new FormData();
    upload.append(
      "file",
      new Blob([await buildThirdPartyPluginZip()], { type: "application/zip" }),
      "probe.zip",
    );
    const installed = await boot.app.request("/api/install/plugin", {
      method: "POST",
      headers: { Authorization: auth.Authorization },
      body: upload,
    });
    expect(installed.status, await installed.text()).toBe(201);
    await restart();
    expect(boot.registry.get(pluginId)?.source).toBe("community");
    expect(
      (await approved(`${sessionPath}/plugins/${pluginId}`, "PUT")).status,
    ).toBe(200);
  });

  afterEach(async () => {
    boot?.runtimeJobWorker.close();
    vi.unstubAllEnvs();
    await rm(root, { recursive: true, force: true });
  });

  it.each(["retry_runtime", "retry_failed_runtimes"])(
    "repairs third-party cards through %s without counting or regenerating the story",
    async (retryType) => {
      // Enabling grants server-code access. Stage runtimes also need their own
      // session grants, obtained through the same public approval flow as UI RPCs.
      for (const name of ["story", "cards"]) {
        const pending = await request(`${sessionPath}/plugin-rpc`, "POST", {
          kind: "runtime",
          pluginId,
          runtimeId: `${pluginId}/${name}`,
          payload: {},
        });
        expect(pending.status, await pending.clone().text()).toBe(202);
        const approval = await pending.json();
        expect(
          (
            await request(
              `/api/approvals/${approval.approvalId}/decision`,
              "POST",
              { decision: "allow", scope: "session" },
            )
          ).status,
        ).toBe(200);
      }
      await action("send_message", { content: "Approach" });
      const [source] = await store.listTurnResults(sessionId);
      expect(source?.commitStatus, JSON.stringify(source?.runtimeResults)).toBe(
        "committed",
      );
      expect(source?.runtimeResults).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            runtimeId: `${pluginId}/story`,
            status: "success",
          }),
          expect.objectContaining({
            runtimeId: `${pluginId}/cards`,
            status: "failed",
          }),
        ]),
      );
      expect(
        await store.getPluginData(sessionId, pluginId, "message", "__turnId"),
      ).toBeNull();
      expect(generate.mock.calls[0]?.[0].defaults).toEqual({
        reasoningEffort: "disabled",
        toolChoice: { name: "lifecycle-probe-cards" },
      });
      const retryPayload = {
        retryFromTurnId: source!.turnId,
        ...(retryType === "retry_runtime"
          ? { runtimeId: `${pluginId}/cards` }
          : { runtimeIds: [`${pluginId}/cards`] }),
      };
      await action(retryType, retryPayload);
      expect(
        await store.getPluginData(sessionId, pluginId, "message", "__turnId"),
      ).toBeNull();
      mode = "cards";
      await action(retryType, retryPayload);
      const rows = await store.listTurnResults(sessionId);
      const retry = rows.at(-1)!;
      expect(retry.turnId).not.toBe(source!.turnId);
      expect(retry.commitStatus).toBe("committed");
      expect(retry.runtimeResults).toEqual([
        expect.objectContaining({
          runtimeId: `${pluginId}/cards`,
          status: "success",
          turnId: retry.turnId,
        }),
      ]);
      expect(
        (await store.getPluginData(sessionId, pluginId, "message", "__turnId"))
          ?.value,
      ).toBe(source!.turnId);
      expect(
        (await store.getPluginData(sessionId, pluginId, "message", "recap"))
          ?.value,
      ).toContain("Approach");
      expect((await store.getSession(sessionId))?.completedPlayerTurns).toBe(1);

      mode = "prose";
      await action("send_message", { content: "Wait" });
      const latest = (await store.listTurnResults(sessionId)).at(-1)!;
      expect(latest.turnId).not.toBe(source!.turnId);
      expect(
        (await store.getPluginData(sessionId, pluginId, "message", "__turnId"))
          ?.value,
      ).toBe(source!.turnId);
      expect((await store.getSession(sessionId))?.completedPlayerTurns).toBe(2);
      await restart();
      const snapshot = await request(`${sessionPath}/view`);
      expect(snapshot.status, await snapshot.clone().text()).toBe(200);
      expect(await snapshot.text()).toContain("Inspect the door");
      expect(
        (await store.getPluginData(sessionId, pluginId, "message", "__turnId"))
          ?.value,
      ).toBe(source!.turnId);
    },
  );

  it("rejects claimed writes, accepts no-change, then commits a real tool write", async () => {
    const rpc = () =>
      approved(`${sessionPath}/plugin-rpc`, "POST", {
        kind: "runtime",
        pluginId,
        runtimeId: `${pluginId}/agent`,
        payload: {},
      });
    const drift = await rpc();
    expect(drift.status, await drift.clone().text()).toBe(200);
    expect(await drift.json()).toMatchObject({
      runtimeResults: [
        expect.objectContaining({
          status: "failed",
          error: expect.stringContaining("requireExplicitCompletion"),
        }),
      ],
    });
    expect(
      await store.getPluginData(sessionId, pluginId, "notes", "agent"),
    ).toBeNull();
    mode = "noop";
    expect(await (await rpc()).json()).toMatchObject({
      runtimeResults: [expect.objectContaining({ status: "success" })],
    });
    expect(
      await store.getPluginData(sessionId, pluginId, "notes", "agent"),
    ).toBeNull();
    mode = "record";
    expect(await (await rpc()).json()).toMatchObject({
      runtimeResults: [expect.objectContaining({ status: "success" })],
    });
    expect(
      (await store.getPluginData(sessionId, pluginId, "notes", "agent"))?.value,
    ).toMatchObject({ text: "Verified write" });
  });
});
