import { closeTestApi } from "../helpers/close-api.js";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LLMAdapter } from "@covel/runtime";
import { createMemoryStore } from "@covel/store/memory";
import {
  bootstrapApi,
  type ApiBootstrapResult,
} from "../../src/routes/api/bootstrap.js";
import { buildThirdPartyPluginZip } from "../helpers/third-party-package.js";

const pluginId = "story-context-probe";
const fixtureRoot = fileURLToPath(
  new URL(`../../../../tests/third-party/${pluginId}/`, import.meta.url),
);
const sessionId = "story-context-session";
const auth = {
  Authorization: "Bearer synthetic-probe-token",
  "Content-Type": "application/json",
};
const sessionPath = `/api/sessions/${sessionId}`;

describe("story-context@1 through an installed community package", () => {
  let root: string;
  let boot: ApiBootstrapResult;
  let store: ReturnType<typeof createMemoryStore>;
  const generate = vi.fn<LLMAdapter["generate"]>(async () => {
    throw new Error("the probe runs no model");
  });

  async function restart() {
    await closeTestApi(boot);
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

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "covel-story-context-probe-"));
    await mkdir(path.join(root, "builtin"));
    await mkdir(path.join(root, "user"));
    vi.stubEnv("COVEL_USER_PLUGINS_DIR", path.join(root, "user"));
    vi.stubEnv("COVEL_DESKTOP_REST_TOKEN", "synthetic-probe-token");
    vi.stubEnv("NODE_ENV", "production");
    generate.mockClear();
    store = createMemoryStore();
    const now = new Date().toISOString();
    await store.createSession({
      id: sessionId,
      phase: "playing",
      setupRuntimes: {},
      seats: [
        { id: "main", controller: "human", role: "player", characters: "auto" },
      ],
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
      new Blob([new Uint8Array(await buildThirdPartyPluginZip(fixtureRoot))], {
        type: "application/zip",
      }),
      "story-context-probe.zip",
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
    // Stage runtimes need their own session grants, through the same public
    // approval flow as a manual run.
    for (const name of ["clock", "omen", "quiet", "story"]) {
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
  });

  afterEach(async () => {
    await closeTestApi(boot);
    vi.unstubAllEnvs();
    await rm(root, { recursive: true, force: true });
  });

  it("hands ranked pre-turn notes to the story and traces them", async () => {
    const response = await approved("/api/actions", "POST", {
      requestId: crypto.randomUUID(),
      sessionId,
      type: "submit_actions",
      payload: { actions: [{ kind: "say", text: "Approach the gate" }] },
    });
    expect(response.status, await response.clone().text()).toBe(200);
    await response.text();

    const [turn] = await store.listTurnResults(sessionId);
    expect(turn?.commitStatus, JSON.stringify(turn?.runtimeResults)).toBe(
      "committed",
    );
    for (const name of ["clock", "omen", "quiet", "story"])
      expect(turn?.runtimeResults).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            runtimeId: `${pluginId}/${name}`,
            status: "success",
          }),
        ]),
      );
    const messages = await store.listMessages(sessionId);
    const story = messages.find((message) => message.role === "assistant");
    // High priority first, titled by the display name; the concealed note
    // with its own title next; `null` adds nothing.
    expect(story?.content).toBe(
      [
        "Player action: Approach the gate",
        "Story Context Probe: World time: dusk of the third day.",
        "Omen: A crow watches the gate.",
      ].join("\n\n"),
    );
    expect(generate).not.toHaveBeenCalled();

    const traces = (await store.listTraceEvents(sessionId)).filter(
      (event) => event.type === "story-context.selected",
    );
    expect(traces).toHaveLength(1);
    expect(traces[0]?.payload).toMatchObject({
      runtimeId: `${pluginId}/story`,
      budgetTokens: 3_000,
      included: [
        {
          title: "Story Context Probe",
          pluginId,
          runtimeId: `${pluginId}/clock`,
          tokens: expect.any(Number),
        },
        { title: "Omen" },
      ],
      omitted: [],
    });
    expect(JSON.stringify(traces)).not.toContain("crow");
  });
});
