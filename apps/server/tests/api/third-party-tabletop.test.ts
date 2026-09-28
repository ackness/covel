import { closeTestApi } from "../helpers/close-api.js";
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
    await closeTestApi(boot);
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
    // Exercise coexistence: the default creator stays active and the tabletop
    // allocation layers on top of its player instead of replacing it.
    await writeFile(
      path.join(root, "builtin/core-fixture/PLUGIN.md"),
      "---\nid: core-fixture\nkind: core\ndescription: Core fixture\nentry: ./entry.mjs\nprovides: [character-creation@1, world-data-provider@1]\ncontributes:\n  tools: [set-schema]\n---\n",
    );
    for (const [name, declaration, handler] of [
      [
        "create",
        "schedule:\n  stage: setup\n  trigger: {type: auto}\nio:\n  output: {contract: character-creation@1}",
        `export default async function (ctx) {
  const characters = await ctx.store.listCharacters(ctx.sessionId);
  const existing = Array.isArray(characters)
    ? characters.find((character) => character.type === "player")
    : undefined;
  if (existing) {
    return { outcome: "success", completion: "done", value: { playerId: existing.id } };
  }
  const now = new Date().toISOString();
  await ctx.store.upsertCharacter({
    id: "fixture-player",
    sessionId: ctx.sessionId,
    name: "Lin",
    type: "player",
    description: "Fixture default creator player",
    fields: { tideReading: 1, stealth: 1, diplomacy: 1, combat: 1 },
    version: 1,
    createdAt: now,
    updatedAt: now,
  });
  return { outcome: "success", completion: "done", value: { playerId: "fixture-player" } };
}
`,
      ],
      [
        "track",
        "schedule:\n  trigger: { type: manual }",
        'export default async function () { return { outcome: "success" }; }\n',
      ],
    ] as const) {
      const dir = path.join(root, "builtin/core-fixture/runtimes", name!);
      await mkdir(dir, { recursive: true });
      await writeFile(
        path.join(dir, "RUNTIME.md"),
        `---\ntype: function\ndescription: Test default\nfunction:\n  handler: ./handler.js\n${declaration}\n---\n`,
      );
      await writeFile(path.join(dir, "handler.js"), handler);
    }
    const world = parseYaml(
      await readFile(path.join(project, "worlds/mistport/world.yaml"), "utf8"),
    );
    const schema = { version: 1, attributes: world.characterSchema.attributes };
    const providerDir = path.join(root, "builtin/core-fixture/runtimes/schema");
    await mkdir(providerDir, { recursive: true });
    await writeFile(
      path.join(providerDir, "RUNTIME.md"),
      "---\ntype: function\ndescription: Schema provider\nfunction:\n  handler: ./handler.js\n  tools:\n    plugin: [set-schema]\nschedule:\n  stage: setup\n  trigger: {type: auto}\nio:\n  output: {contract: world-data-provider@1}\n---\n",
    );
    // The public output contract has an explicit empty business value; the
    // character schema itself is committed through the tool's domain proposal.
    await writeFile(
      path.join(providerDir, "handler.js"),
      `export default async function (ctx) { await ctx.tools.call("set-schema", {}); return {outcome: "success", value: {}, completion: "done"}; }`,
    );
    await writeFile(
      path.join(root, "builtin/core-fixture/entry.mjs"),
      `
      export default function(api) {
        api.registerTool(api.toolkit.tool({name: "set-schema", description: "Set fixture schema", parameters: api.toolkit.z.object({}), execute: (_args, ctx) => api.toolkit.withPendingProposals({}, [{id: crypto.randomUUID(), type: "character.schema.set", sessionId: ctx.sessionId, turnId: ctx.turnId, source: {pluginId: ctx.pluginId, runtimeId: ctx.runtimeId}, timestamp: new Date().toISOString(), payload: ${JSON.stringify({ types: ["npc", "companion"], attributes: schema.attributes })}}])}));
      }
    `,
    );
    await cp(
      path.join(project, "plugins/narrator"),
      path.join(root, "builtin/narrator"),
      { recursive: true, filter: (source) => !source.includes("node_modules") },
    );
    // Builtin plugin dependencies are staged by the desktop/server distribution.
    // Junction: directory symlinks need Windows symlink privileges, junctions
    // do not (the type flag is ignored on POSIX).
    await symlink(
      path.join(project, "plugins/narrator/node_modules"),
      path.join(root, "builtin/narrator/node_modules"),
      "junction",
    );
    await cp(
      path.join(project, "plugins/dice-check"),
      path.join(root, "builtin/dice-check"),
      { recursive: true, filter: (source) => !source.includes("node_modules") },
    );
    await symlink(
      path.join(project, "plugins/dice-check/node_modules"),
      path.join(root, "builtin/dice-check/node_modules"),
      "junction",
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
    schema: contract:${pluginId}.rules.initial@1
    to: contract:${pluginId}.rules.initial@1
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
    await closeTestApi(boot);
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
    // The coexisting default creator made its player, but the plugin never
    // presented a form nor touched its fields.
    expect(await store.listCharacters(sessionId)).toEqual([
      expect.objectContaining({
        id: "fixture-player",
        fields: { tideReading: 1, stealth: 1, diplomacy: 1, combat: 1 },
      }),
    ]);
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
      `${pluginId}-allocation`,
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
      if (phase === "setup") {
        // Opening flow: allocation layers onto the existing player — the form
        // appears, and submitting patches fields without recreating the record.
        await action("start_session", {});
        const allocation = await latestForm();
        expect(allocation.form.interactionId).toBe(`${pluginId}-allocation`);
        const accepted = await submit(allocation, {
          tideReading: 4,
          combat: 2,
        });
        expect(accepted.status, await accepted.clone().text()).toBe(200);
        await action("send_message", { content: "Begin" });
        const after = (await store.listCharacters(sessionId))[0]!;
        expect(after.id).toBe("existing-player");
        expect(after.createdAt).toBe(before[0]!.createdAt);
        expect(after.fields).toMatchObject({
          tideReading: 4,
          stealth: 2,
          diplomacy: 2,
          combat: 2,
        });
      } else {
        // Late enable during play: rules initialize, the player is untouched
        // and no form is re-asked.
        await action("send_message", { content: "Continue" });
        expect(await store.listCharacters(sessionId)).toEqual(before);
      }
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
    const values = { tideReading: 4, combat: 2 };
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
      "tideReading",
      "stealth",
      "diplomacy",
      "combat",
    ]);
    const accepted = await submit(creation, {
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

  it("validates before acceptance, applies once, persists checks across restart/retry, and keeps the default creator active", async () => {
    // Coexistence: the default creator runs alongside the allocation runtime
    // instead of being suppressed by the tabletop capability.
    expect(
      boot.registry.getActiveRuntimes(sessionId).map((runtime) => runtime.name),
    ).toEqual(
      expect.arrayContaining([
        `${pluginId}/creation`,
        "core-fixture/create",
        "core-fixture/track",
      ]),
    );
    await action("start_session", {});
    const creation = await latestForm();
    expect(creation.form.interactionId).toBe(`${pluginId}-allocation`);
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
      { tideReading: 4, combat: 4 },
      { tideReading: 6, combat: 0 },
      { tideReading: 3.5, combat: 2.5 },
      { tideReading: "", combat: 5 },
      { characterName: "Ada", tideReading: 4, combat: 2 },
    ]) {
      const rejected = await submit(creation, values);
      expect(rejected.status, await rejected.text()).toBe(400);
      expect(await store.listPlayerInputs(sessionId)).toHaveLength(0);
    }
    // Rejections never reach the character: the default creator's fields stay
    // at their schema defaults until a valid allocation commits.
    expect(await store.listCharacters(sessionId)).toEqual([
      expect.objectContaining({
        id: "fixture-player",
        fields: { tideReading: 1, stealth: 1, diplomacy: 1, combat: 1 },
      }),
    ]);
    await restart();
    await enable();
    const values = { tideReading: 4, combat: 2 };
    const accepted = await submit(creation, values);
    expect(accepted.status, await accepted.text()).toBe(200);
    expect((await submit(creation, values)).status).toBe(200);
    expect((await submit(creation, { ...values, combat: 3 })).status).toBe(400);
    expect(await store.listPlayerInputs(sessionId)).toHaveLength(1);
    await action("send_message", { content: "Begin" });
    expect(await store.listCharacters(sessionId)).toEqual([
      expect.objectContaining({
        name: "Lin",
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
    ).not.toContain(`${pluginId}/creation`);
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

  it("keeps a submitted tabletop check separate from dice-pool receipts in the following turn", async () => {
    await action("start_session", {});
    const allocation = await latestForm();
    expect(
      (await submit(allocation, { tideReading: 4, combat: 2 })).status,
    ).toBe(200);
    await action("send_message", { content: "Begin" });
    const enabledDice = await request(
      `${sessionPath}/plugins/dice-check`,
      "PUT",
    );
    expect(enabledDice.status, await enabledDice.text()).toBe(200);

    const opened = await request(`${sessionPath}/plugin-rpc`, "POST", {
      kind: "runtime",
      pluginId,
      runtimeId: `${pluginId}/check`,
      payload: { openForm: true },
    });
    expect(opened.status, await opened.text()).toBe(200);
    const check = await latestForm();
    expect(
      (
        await submit(check, {
          action: "Check the receiver wiring for a loose connection",
          attribute: "tideReading",
          difficulty: "12",
        })
      ).status,
    ).toBe(200);

    let emit = true;
    let expectTabletopReceipt = true;
    generate.mockImplementation(async (request) => {
      if (!request.tools?.some((tool) => tool.name === "emit-event") || !emit) {
        return {
          content: "The receiver responds.",
          toolCalls: [],
          finishReason: "stop",
          usage: { inputTokens: 1, outputTokens: 1 },
        };
      }
      const prompt = request.messages
        .map((message) =>
          typeof message.content === "string" ? message.content : "",
        )
        .join("\n");
      const inputBlock = prompt.match(
        /<runtime-inputs>\s*(\{[^\n]+\})\s*<\/runtime-inputs>/,
      );
      const slots = inputBlock
        ? (JSON.parse(inputBlock[1]!) as {
            tabletopCheck?: { value?: string };
            "check-results"?: { value?: string };
          })
        : {};
      const tabletop = slots.tabletopCheck?.value?.match(
        /Settled tabletop check \(do not reroll or change the result\): (\{.*\})/,
      );
      const receipt = tabletop
        ? (JSON.parse(tabletop[1]!) as {
            action: string;
            attribute: string;
            die: number;
            modifier: number;
            difficulty: number;
            total: number;
            outcome: string;
          })
        : null;
      expect(Boolean(receipt)).toBe(expectTabletopReceipt);
      const pool = slots["check-results"]?.value?.match(
        /Pre-rolled d20s: #1: (\d+)/,
      );
      const roll = receipt?.die ?? Number(pool?.[1]);
      expect(Number.isInteger(roll)).toBe(true);
      const modifier = receipt?.modifier ?? 0;
      const dc = receipt?.difficulty ?? 12;
      const outcome =
        receipt?.outcome ??
        (roll === 20
          ? "critical-success"
          : roll === 1
            ? "critical-failure"
            : roll + modifier >= dc
              ? "success"
              : "failure");
      emit = false;
      return {
        content: null,
        toolCalls: [
          {
            id: `check-${crypto.randomUUID()}`,
            name: "emit-event",
            arguments: JSON.stringify({
              topic: "check.resolved",
              data: {
                checks: [
                  {
                    action: receipt?.action ?? "Inspect the receiver",
                    attribute: receipt?.attribute ?? "tideReading",
                    roll,
                    modifier,
                    dc,
                    difficulty: "normal",
                    total: roll + modifier,
                    outcome,
                  },
                ],
              },
            }),
          },
        ],
        finishReason: "tool_calls",
        usage: { inputTokens: 1, outputTokens: 1 },
      };
    });

    const settled = await action("send_message", {
      content: "Resolve the submitted check",
    });
    expect(settled.runtimeResults).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          runtimeId: `${pluginId}/check`,
          status: "success",
        }),
        expect.objectContaining({
          runtimeId: "dice-check/recorder",
          status: "skipped",
        }),
      ]),
    );
    expect(
      settled.runtimeResults
        .find((result) => result.runtimeId === "narrator")
        ?.toolCalls.map((call) => call.toolName),
    ).toContain("emit-event");
    expect(
      await store.listPluginData(sessionId, pluginId, "checks"),
    ).toHaveLength(1);
    expect(
      await store.listPluginData(sessionId, "dice-check", "checks"),
    ).toHaveLength(0);

    emit = true;
    expectTabletopReceipt = false;
    const ordinary = await action("send_message", {
      content: "Inspect the receiver again",
    });
    expect(ordinary.runtimeResults).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          runtimeId: "dice-check/recorder",
          status: "success",
        }),
      ]),
    );
    expect(
      await store.listPluginData(sessionId, "dice-check", "checks"),
    ).toHaveLength(1);
  });
});
