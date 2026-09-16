import {
  mkdtemp,
  mkdir,
  readFile,
  writeFile,
  cp,
  rm,
  symlink,
} from "node:fs/promises";
import { parse as parseYaml } from "yaml";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSqliteStore, type DataStore } from "@covel/store";
import { importWorldDataForSession } from "../../src/world-data/session-import.js";
import type { LLMAdapter } from "@covel/runtime";
import {
  bootstrapApi,
  type ApiBootstrapResult,
} from "../../src/routes/api/bootstrap.js";
import {
  buildTabletopProbeZip,
  tabletopProbeId,
} from "../helpers/tabletop-package.js";

const project = path.resolve(import.meta.dirname, "../../../..");
const pluginId = tabletopProbeId;
const sessionId = "tabletop-session";
const client = vi.hoisted(() => ({ address: "" }));
vi.mock("@hono/node-server/conninfo", () => ({
  getConnInfo: () => ({ remote: { address: client.address } }),
}));
const sessionPath = `/api/sessions/${sessionId}`;
const auth = {
  Authorization: "Bearer synthetic-tabletop-token",
  "Content-Type": "application/json",
};
const rules = {
  budget: 4,
  attributes: [
    { id: "tideReading", label: "Tide reading", base: 1, max: 5 },
    { id: "combat", label: "Combat", base: 1, max: 5 },
  ],
};

describe("tabletop package installed as a third-party ZIP", () => {
  let root: string;
  let boot: ApiBootstrapResult;
  let store: DataStore;
  const generate = vi.fn<LLMAdapter["generate"]>(async () => ({
    content: "The scene continues.",
    toolCalls: [],
    finishReason: "stop",
    usage: { inputTokens: 1, outputTokens: 1 },
  }));

  async function restart() {
    boot?.runtimeJobWorker.close();
    await boot?.eventBus.flush();
    await store.close();
    store = createSqliteStore(path.join(root, "session.sqlite"));
    boot = await bootstrapApi({
      pluginsDir: path.join(root, "builtin"),
      pluginsDirs: [path.join(root, "builtin"), path.join(root, "user")],
      store,
      storeBackend: "sqlite",
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
  async function allow(response: Response) {
    expect(response.status, await response.clone().text()).toBe(202);
    const pending = await response.json();
    expect(pending.status).toBe("approval-required");
    const allowed = await request(
      `/api/approvals/${pending.approvalId}/decision`,
      "POST",
      { decision: "allow", scope: "session" },
    );
    expect(allowed.status, await allowed.text()).toBe(200);
  }
  async function enable() {
    const first = await request(`${sessionPath}/plugins/${pluginId}`, "PUT");
    if (first.status === 202) await allow(first);
    const enabled = await request(`${sessionPath}/plugins/${pluginId}`, "PUT");
    expect(enabled.status, await enabled.text()).toBe(200);
  }
  async function actionRequest(type: string, payload: Record<string, unknown>) {
    const body = { requestId: crypto.randomUUID(), sessionId, type, payload };
    const previous = await store.listTurnResults(sessionId);
    for (let attempt = 0; attempt < 4; attempt++) {
      const response = await request("/api/actions", "POST", body);
      if (response.status !== 202) return response;
      expect(await store.listTurnResults(sessionId)).toEqual(previous);
      await allow(response);
    }
    throw new Error("Action approval did not settle");
  }
  async function action(type: string, payload: Record<string, unknown>) {
    const previousIds = new Set(
      (await store.listTurnResults(sessionId)).map((row) => row.turnId),
    );
    const response = await actionRequest(type, payload);
    const text = await response.text();
    expect(response.status, text).toBe(200);
    const events = text
      .split("\n")
      .filter((line) => line.startsWith("data: "))
      .map((line) => JSON.parse(line.slice(6)));
    expect(
      events.filter((event) => event.type === "error.occurred"),
      text,
    ).toEqual([]);
    expect(
      events.some(
        (event) =>
          event.type === "execution.completed" &&
          event.payload.committed === true,
      ),
      text,
    ).toBe(true);
    const results = await store.listTurnResults(sessionId);
    const last = results.at(-1)!;
    expect(previousIds.has(last.turnId), text).toBe(false);
    expect(
      events.some((event) => event.turnId === last.turnId),
      text,
    ).toBe(true);
    expect(last?.commitStatus, text).toBe("committed");
    expect(
      last.runtimeResults.filter((result) => result.status === "failed"),
      text,
    ).toEqual([]);
    return last;
  }
  async function latestForm() {
    const messages = await store.listTurnMessages(sessionId);
    const message = messages.findLast(
      (item) =>
        Array.isArray(item.pendingInput) && item.pendingInput.length > 0,
    )!;
    expect(message).toBeDefined();
    return {
      turnId: message.turnId,
      form: (message.pendingInput as Array<Record<string, unknown>>)[0]!,
    };
  }
  async function submit(
    target: Awaited<ReturnType<typeof latestForm>>,
    values: Record<string, unknown>,
  ) {
    return request(`${sessionPath}/plugin-rpc`, "POST", {
      kind: "action",
      pluginId: "framework",
      action: "submit-form",
      payload: {
        turnId: target.turnId,
        submissions: [
          { interactionId: target.form.interactionId, type: "form", values },
        ],
      },
    });
  }

  beforeEach(async () => {
    // Each isolated installation has its own rate-limit client bucket.
    client.address = crypto.randomUUID();
    root = await mkdtemp(path.join(tmpdir(), "covel-tabletop-"));
    await mkdir(path.join(root, "builtin/core-fixture"), { recursive: true });
    await mkdir(path.join(root, "user"));
    // Exercise partial replacement without executing an LLM-driven default creator.
    await writeFile(
      path.join(root, "builtin/core-fixture/PLUGIN.md"),
      "---\nname: core-fixture\ndescription: Core fixture\npluginType: core-plugin\n---\n",
    );
    for (const [name, declaration] of [
      [
        "create",
        "stage: setup\ntrigger: { type: auto }\ncapabilities: [character-creation]\nfallbackFor: character-creation",
      ],
      ["track", "trigger: { type: manual }"],
    ]) {
      const dir = path.join(root, "builtin/core-fixture/runtimes", name!);
      await mkdir(dir, { recursive: true });
      await writeFile(
        path.join(dir, "PLUGIN.md"),
        `---\nname: core-fixture/${name}\ndescription: Test default\npluginType: core-plugin\nruntimeType: function\nhandler: ./handler.js\n${declaration}\n---\n`,
      );
      await writeFile(
        path.join(dir, "handler.js"),
        "export default async function () { throw new Error('Default creator must be replaced'); }\n",
      );
    }
    const world = parseYaml(
      await readFile(path.join(project, "worlds/mistport/world.yaml"), "utf8"),
    );
    const schema = { version: 1, attributes: world.characterAttributes };
    const providerDir = path.join(root, "builtin/core-fixture/runtimes/schema");
    await mkdir(providerDir, { recursive: true });
    await writeFile(
      path.join(providerDir, "PLUGIN.md"),
      "---\nname: core-fixture/schema\ndescription: Schema provider\npluginType: core-plugin\nruntimeType: function\nhandler: ./handler.js\nstage: setup\ntrigger: { type: auto }\ncapabilities: [world-data-provider]\n---\n",
    );
    await writeFile(
      path.join(providerDir, "handler.js"),
      `export default async function () { const worldSchema = ${JSON.stringify(schema)}; return { outcome: "success", completion: "done", value: { worldSchema }, effects: { pluginData: [{ namespace: "schema", key: "character-attributes", value: worldSchema }] } }; }`,
    );
    await cp(
      path.join(project, "plugins/narrator"),
      path.join(root, "builtin/narrator"),
      { recursive: true, filter: (source) => !source.includes("node_modules") },
    );
    // Builtin plugin dependencies are staged by the desktop/server distribution.
    await symlink(
      path.join(project, "plugins/narrator/node_modules"),
      path.join(root, "builtin/narrator/node_modules"),
      "dir",
    );
    vi.stubEnv("COVEL_USER_PLUGINS_DIR", path.join(root, "user"));
    vi.stubEnv("COVEL_DESKTOP_REST_TOKEN", "synthetic-tabletop-token");
    vi.stubEnv("NODE_ENV", "production");
    generate.mockClear();
    store = createSqliteStore(path.join(root, "session.sqlite"));
    const now = new Date().toISOString();
    await store.createSession({
      id: sessionId,
      worldId: null,
      status: "active",
      phase: "setup",
      setupRuntimes: {},
      completedPlayerTurns: 0,
      activePlugins: ["core-fixture", "narrator"],
      locale: "en-US",
      metadata: {
        approvalScopeNonce: crypto.randomUUID(),
        sessionIncarnationNonce: crypto.randomUUID(),
      },
      createdAt: now,
      updatedAt: now,
    });
    await restart();
    const zip = await buildTabletopProbeZip();
    const upload = new FormData();
    upload.append(
      "file",
      new Blob([zip], { type: "application/zip" }),
      "tabletop-rules.zip",
    );
    const installed = await boot.app.request("/api/install/plugin", {
      method: "POST",
      headers: { Authorization: auth.Authorization },
      body: upload,
    });
    expect(installed.status, await installed.text()).toBe(201);
    await restart();
    expect(boot.registry.get(pluginId)?.source).toBe("community");
    await enable();
    const worldRoot = path.join(root, "worlds/rules-world");
    await mkdir(worldRoot, { recursive: true });
    await writeFile(
      path.join(worldRoot, "world.yaml"),
      "schemaVersion: '1'\nid: rules-world\nname: Rules world\nworldData: world.data.yaml\n",
    );
    await writeFile(
      path.join(worldRoot, "world.data.yaml"),
      `schemaVersion: 1
sources:
  tabletop:
    kind: json
    path: rules.json
    schema: plugin://${pluginId}/rules
    to: plugin:${pluginId}/rules
    key: id
`,
    );
    await writeFile(
      path.join(worldRoot, "rules.json"),
      JSON.stringify({ id: "creation", ...rules }),
    );
    const imported = await importWorldDataForSession({
      store,
      sessionId,
      worldId: "rules-world",
      worldsDirs: [path.join(root, "worlds")],
      covelHome: path.join(root, "home"),
      now,
      preflight: { registry: boot.registry, activePlugins: [pluginId] },
    });
    expect(imported.written).toBe(1);
    expect(
      (await store.getPluginData(sessionId, pluginId, "rules", "creation"))
        ?.value,
    ).toEqual({ id: "creation", ...rules });
  });
  afterEach(async () => {
    boot?.runtimeJobWorker.close();
    await boot?.eventBus.flush();
    await store?.close();
    vi.unstubAllEnvs();
    await rm(root, { recursive: true, force: true });
  });

  it("rejects world-incompatible configuration before presenting an unfulfillable form", async () => {
    await store.setPluginData({
      id: "world-rules",
      sessionId,
      pluginId,
      namespace: "rules",
      key: "creation",
      value: {
        ...rules,
        attributes: [{ id: "combat", label: "Combat", base: 1, max: 99 }],
      },
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    const previousIds = new Set(
      (await store.listTurnResults(sessionId)).map((row) => row.turnId),
    );
    const response = await actionRequest("start_session", {});
    expect(response.status, await response.text()).toBe(200);
    const result = (await store.listTurnResults(sessionId)).at(-1)!;
    expect(previousIds.has(result.turnId)).toBe(false);
    expect(
      result.runtimeResults.find(
        (item) => item.runtimeId === `${pluginId}/creation`,
      ),
    ).toMatchObject({
      status: "failed",
      error: expect.stringContaining("world schema"),
    });
    expect(await store.listPlayerInputs(sessionId)).toHaveLength(0);
    expect(await store.listCharacters(sessionId)).toHaveLength(0);
    // The provider completed before creation failed. Retrying must use its
    // committed schema, not rely on a same-execution input that is now absent.
    await store.deletePluginData(sessionId, pluginId, "rules", "creation");
    const recovered = await action("start_session", {});
    expect(
      recovered.runtimeResults.some(
        (runtime) => runtime.runtimeId === "core-fixture/schema",
      ),
    ).toBe(false);
    expect((await latestForm()).form.fields).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "tideReading" }),
        expect.objectContaining({ name: "stealth" }),
      ]),
    );
  });

  it("requests exact runtime grants before creating any turn and honors denial", async () => {
    const response = await request("/api/actions", "POST", {
      requestId: "approval-check",
      sessionId,
      type: "start_session",
      payload: {},
    });
    expect(response.status).toBe(202);
    const pending = await response.json();
    expect(pending.pending).toMatchObject({
      pluginId,
      action: expect.stringMatching(/^runtime:tabletop-probe\//),
    });
    const denied = await request(
      `/api/approvals/${pending.approvalId}/decision`,
      "POST",
      { decision: "deny", scope: "session" },
    );
    expect(denied.status).toBe(200);
    expect(await store.listTurnResults(sessionId)).toEqual([]);
    expect(await store.listTurnMessages(sessionId)).toEqual([]);
    expect(await store.listCharacters(sessionId)).toEqual([]);
    expect((await store.getSession(sessionId))?.completedPlayerTurns).toBe(0);
    await action("start_session", {});
    expect((await latestForm()).form.interactionId).toBe(
      `${pluginId}-character`,
    );
  });

  it.each(["setup", "playing"] as const)(
    "initializes checks without rebuilding an existing player during %s",
    async (phase) => {
      const now = new Date().toISOString();
      await store.upsertCharacter({
        id: "existing-player",
        sessionId,
        name: "Lin",
        type: "player",
        description: "An existing adventurer",
        fields: { tideReading: 3, stealth: 2, diplomacy: 2, combat: 1 },
        version: 1,
        createdAt: now,
        updatedAt: now,
      });
      const before = await store.listCharacters(sessionId);
      await store.updateSession(sessionId, { phase });
      await action(
        phase === "setup" ? "start_session" : "send_message",
        phase === "setup" ? {} : { content: "Continue" },
      );
      expect(await store.listCharacters(sessionId)).toEqual(before);
      expect(
        (await store.getPluginData(sessionId, pluginId, "setup", "rules"))
          ?.value,
      ).toMatchObject(rules);
      const opened = await request(`${sessionPath}/plugin-rpc`, "POST", {
        kind: "runtime",
        pluginId,
        runtimeId: `${pluginId}/check`,
        payload: { openForm: true },
      });
      expect(opened.status, await opened.text()).toBe(200);
      expect((await latestForm()).form.interactionId).toMatch(/-check-/);
    },
  );

  it("reauthorizes a restored form directly without toggling its plugin", async () => {
    await action("start_session", {});
    const creation = await latestForm();
    const values = { characterName: "Ada", tideReading: 4, combat: 2 };
    await restart();
    const approval = await submit(creation, values);
    expect(approval.status, await approval.clone().text()).toBe(202);
    const pending = await approval.json();
    expect(pending.pending).toMatchObject({
      pluginId,
      action: "covel:plugin-server-code",
    });
    expect(await store.listPlayerInputs(sessionId)).toEqual([]);
    expect(
      (
        await request(`/api/approvals/${pending.approvalId}/decision`, "POST", {
          decision: "deny",
          scope: "session",
        })
      ).status,
    ).toBe(200);
    expect(await store.listPlayerInputs(sessionId)).toEqual([]);
    await allow(await submit(creation, values));
    expect((await submit(creation, { ...values, combat: 4 })).status).toBe(400);
    expect(await store.listPlayerInputs(sessionId)).toEqual([]);
    expect((await submit(creation, values)).status).toBe(200);
    expect((await submit(creation, values)).status).toBe(200);
    expect(await store.listPlayerInputs(sessionId)).toHaveLength(1);
    expect(
      (await request(`${sessionPath}/approvals?pluginId=${pluginId}`, "DELETE"))
        .status,
    ).toBe(200);
    await allow(await submit(creation, values));
    expect((await submit(creation, values)).status).toBe(200);
    expect(await store.listPlayerInputs(sessionId)).toHaveLength(1);
    await restart();
    expect(
      (await request(`${sessionPath}/plugins/${pluginId}`, "DELETE")).status,
    ).toBe(200);
    expect((await submit(creation, values)).status).toBe(400);
    expect(
      await (await request(`${sessionPath}/approvals`)).json(),
    ).toMatchObject({ items: [] });
  });

  it("derives point buy from the actual mistport ability schema without allocating health", async () => {
    await store.deletePluginData(sessionId, pluginId, "rules", "creation");
    await action("start_session", {});
    const creation = await latestForm();
    const fields = creation.form.fields as Array<{ name: string }>;
    expect(fields.map((field) => field.name)).toEqual([
      "characterName",
      "tideReading",
      "stealth",
      "diplomacy",
      "combat",
    ]);
    const accepted = await submit(creation, {
      characterName: "Lin",
      tideReading: 2,
      stealth: 2,
      diplomacy: 2,
      combat: 2,
    });
    expect(accepted.status, await accepted.text()).toBe(200);
    await action("send_message", { content: "Begin" });
    expect((await store.listCharacters(sessionId))[0]).toMatchObject({
      name: "Lin",
      fields: { tideReading: 2, stealth: 2, diplomacy: 2, combat: 2 },
    });
  });

  it("validates before acceptance, creates once, persists checks across restart/retry, and restores the default on removal", async () => {
    expect(
      boot.registry.getActiveRuntimes(sessionId).map((runtime) => runtime.name),
    ).toEqual(
      expect.arrayContaining([`${pluginId}/creation`, "core-fixture/track"]),
    );
    expect(
      boot.registry.getActiveRuntimes(sessionId).map((runtime) => runtime.name),
    ).not.toContain("core-fixture/create");
    await action("start_session", {});
    const creation = await latestForm();
    expect(creation.form).toMatchObject({
      validation: { name: "point-buy" },
      fields: expect.arrayContaining([
        expect.objectContaining({
          name: "combat",
          type: "number",
          min: 1,
          max: 5,
          step: 1,
          defaultValue: 1,
        }),
      ]),
    });
    for (const values of [
      { characterName: "Ada", tideReading: 4, combat: 4 },
      { characterName: "Ada", tideReading: 6, combat: 0 },
      { characterName: "Ada", tideReading: 3.5, combat: 2.5 },
      { characterName: "Ada", tideReading: "", combat: 5 },
    ]) {
      const rejected = await submit(creation, values);
      expect(rejected.status, await rejected.text()).toBe(400);
      expect(await store.listPlayerInputs(sessionId)).toHaveLength(0);
      expect(await store.listCharacters(sessionId)).toHaveLength(0);
    }
    await restart();
    await enable();
    const values = { characterName: "Ada", tideReading: 4, combat: 2 };
    const accepted = await submit(creation, values);
    expect(accepted.status, await accepted.text()).toBe(200);
    expect((await submit(creation, values)).status).toBe(200);
    expect((await submit(creation, { ...values, combat: 3 })).status).toBe(400);
    expect(await store.listPlayerInputs(sessionId)).toHaveLength(1);
    await action("send_message", { content: "Begin" });
    expect(await store.listCharacters(sessionId)).toEqual([
      expect.objectContaining({
        name: "Ada",
        fields: expect.objectContaining({ tideReading: 4, combat: 2 }),
      }),
    ]);
    expect((await store.getSession(sessionId))?.phase).toBe("playing");
    const ordinary = await action("send_message", {
      content: "Inspect the tide",
    });
    expect(
      (await store.listTurnMessages(sessionId)).filter(
        (message) =>
          message.turnId === ordinary.turnId &&
          Array.isArray(message.pendingInput) &&
          message.pendingInput.length,
      ),
    ).toEqual([]);
    const opened = await request(`${sessionPath}/plugin-rpc`, "POST", {
      kind: "runtime",
      pluginId,
      runtimeId: `${pluginId}/check`,
      payload: { openForm: true },
    });
    expect(opened.status, await opened.text()).toBe(200);
    const check = await latestForm();
    const checkAccepted = await submit(check, {
      action: "Read the tide",
      attribute: "tideReading",
      difficulty: "12",
    });
    expect(checkAccepted.status, await checkAccepted.text()).toBe(200);
    const resolved = await action("send_message", {
      content: "Resolve the check",
    });
    const receipts = await store.listPluginData(sessionId, pluginId, "checks");
    expect(receipts).toHaveLength(1);
    const receipt = receipts[0]!.value as Record<string, unknown>;
    expect(receipt).toMatchObject({
      attribute: "tideReading",
      modifier: 4,
      difficulty: 12,
    });
    expect(receipt.die).toBeGreaterThanOrEqual(1);
    expect(receipt.die).toBeLessThanOrEqual(20);
    expect(receipt.total).toBe(Number(receipt.die) + 4);
    expect(
      JSON.stringify(
        generate.mock.calls.filter(([request]) =>
          JSON.stringify(request.messages).includes("<runtime-inputs>"),
        ),
      ).toString(),
    ).toContain("Settled tabletop check");
    await restart();
    await enable();
    const retried = await action("retry_runtime", {
      runtimeId: `${pluginId}/check`,
    });
    expect(retried.turnId).not.toBe(resolved.turnId);
    expect(
      retried.runtimeResults.find(
        (result) => result.runtimeId === `${pluginId}/check`,
      )?.output,
    ).toMatchObject({ receipt });
    expect(
      (await store.listPluginData(sessionId, pluginId, "checks")).map(
        (row) => row.value,
      ),
    ).toEqual([receipt]);
    expect(await store.listCharacters(sessionId)).toHaveLength(1);
    const disabled = await request(
      `${sessionPath}/plugins/${pluginId}`,
      "DELETE",
    );
    expect(disabled.status, await disabled.text()).toBe(200);
    expect((await submit(creation, values)).status).toBe(400);
    expect(
      boot.registry.getActiveRuntimes(sessionId).map((runtime) => runtime.name),
    ).toContain("core-fixture/create");
    const removed = await request(`/api/plugins/${pluginId}`, "DELETE");
    expect(removed.status, await removed.text()).toBe(200);
    await restart();
    expect(boot.registry.get(pluginId)).toBeUndefined();
    expect(await store.listCharacters(sessionId)).toHaveLength(1);
    expect(
      await store.listPluginData(sessionId, pluginId, "checks"),
    ).toHaveLength(1);
  });
});
