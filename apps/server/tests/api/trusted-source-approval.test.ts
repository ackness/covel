import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { Hono } from "hono";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { defaultSessionSeats, readRuntimeEnv } from "@covel/shared";
import { createMemoryStore } from "@covel/store/memory";
import {
  bootstrapApi,
  type ApiBootstrapResult,
} from "../../src/routes/api/bootstrap.js";
import { preflightRuntimeApprovals } from "../../src/routes/api/actions/approval-preflight.js";
import { deriveHostProfile } from "../../src/host-profile.js";
import { hashSessionOwnerToken } from "../../src/routes/api/session/session-guard.js";
import { createOriginGuardMiddleware } from "../../src/middleware/origin-guard.js";
import { installRoutes } from "../../src/routes/api/install.js";
import { verifyTrustedSourcesAtBoot } from "../../src/trust/boot.js";
import { readReceipt } from "../../src/routes/api/install/package-files.js";
import { closeTestApi } from "../helpers/close-api.js";
import { parseJsonFrames } from "./sse-test-utils.js";
import { id, packageFixture } from "../trust/fixtures.js";
let root: string;
let api: ApiBootstrapResult | undefined;
let app: Hono;
const store = () => api!.store;
const serverSettingPath = "/api/config/server-settings";
const baseline = {
  entry: "./server.js",
  contributes: { actions: ["probe"] },
  runtime: { schedule: { trigger: { type: "manual" } } },
};
const code =
  'export default c => { c.registerRpc("probe", async () => ({ ok: true })); };';
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "covel-trusted-route-"));
  vi.stubEnv("NODE_ENV", "test");
  vi.stubEnv("DEPLOYMENT_TIER", "self");
  vi.stubEnv("COVEL_DESKTOP_REST_TOKEN", "");
  vi.stubEnv("COVEL_TRUSTED_SOURCES", "");
  vi.stubEnv("COVEL_USER_PLUGINS_DIR", root);
});
afterEach(async () => {
  await closeTestApi(api);
  api = undefined;
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  await rm(root, { recursive: true, force: true });
});
async function session(
  sessionId = "session",
  backend = store(),
  activePlugins: string[] = [],
) {
  const now = new Date().toISOString();
  await backend.createSession({
    id: sessionId,
    phase: "playing",
    setupRuntimes: {},
    status: "active",
    completedPlayerTurns: 0,
    activePlugins,
    locale: "en-US",
    seats: defaultSessionSeats(),
    createdAt: now,
    updatedAt: now,
    metadata: {
      approvalScopeNonce: crypto.randomUUID(),
      sessionIncarnationNonce: crypto.randomUUID(),
      ownerTokenHash: hashSessionOwnerToken("owner"),
    },
  });
}
async function build(
  options: {
    snapshot?: null;
    trusted?: boolean;
    manifest?: object;
    files?: Record<string, string>;
    hosted?: boolean;
    desktop?: boolean;
    restoredActive?: boolean;
  } = {},
) {
  if (options.hosted) {
    vi.stubEnv("DEPLOYMENT_TIER", "demo");
    vi.stubEnv("COVEL_DESKTOP_REST_TOKEN", "operator");
    vi.stubEnv("COVEL_TRUSTED_SOURCES", "example/plugins");
  }
  if (options.desktop) vi.stubEnv("COVEL_DESKTOP_REST_TOKEN", "desktop");
  const fixture = await packageFixture(root, {
    manifest: options.manifest ?? baseline,
    files: options.files ?? { "server.js": code },
    snapshot: options.snapshot,
  });
  const builtin = path.join(root, ".builtin");
  await mkdir(builtin);
  const memory = createMemoryStore();
  if (options.trusted !== false)
    await memory.setServerSetting({
      key: "trust.sources",
      value: ["example/plugins"],
      updatedAt: new Date().toISOString(),
    });
  if (options.restoredActive) await session("session", memory, [id]);
  api = await bootstrapApi({
    pluginsDir: builtin,
    pluginsDirs: [builtin, root],
    store: memory,
    storeBackend: "memory",
    hostProfile: deriveHostProfile(readRuntimeEnv(), {
      storeBackend: "sqlite",
    }),
    llmAdapter: { generate: vi.fn() },
  });
  await verifyTrustedSourcesAtBoot(api.trustedSources);
  api.app.route("/api/install", installRoutes);
  api.app.get("/__preflight", async (c) => {
    const current = await c.get("store").getSession("session");
    if (!current) throw new Error("missing session");
    return (
      (await preflightRuntimeApprovals(c, current, [id])) ??
      c.json({ ok: true })
    );
  });
  app = new Hono();
  app.use(
    "*",
    createOriginGuardMiddleware(() => false),
  );
  app.route("/", api.app);
  if (!options.restoredActive) await session();
  return fixture;
}
function put(entries: unknown, headers: Record<string, string> = {}) {
  return app.request(serverSettingPath, {
    method: "PUT",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify({ entries }),
  });
}
function enable(sessionId = "session", headers: Record<string, string> = {}) {
  return app.request(`/api/sessions/${sessionId}/plugins/${id}`, {
    method: "PUT",
    headers,
  });
}
async function pending(response: Response) {
  expect(response.status, await response.clone().text()).toBe(202);
  const body = await response.json();
  expect(body.status).toBe("approval-required");
  expect(body.pending.action).toBe("covel:plugin-server-code");
  return body.approvalId as string;
}
it("wires implicit grants through bootstrap for enable and runtime preflight, while per-action RPC still prompts", async () => {
  await build();
  expect((await enable()).status).toBe(200);
  const plugins = await (
    await app.request("/api/sessions/session/plugins")
  ).json();
  expect(plugins.items).toContainEqual(
    expect.objectContaining({
      id,
      serverCodeApproved: true,
      serverCodeApprovedBy: "trusted-source",
    }),
  );
  expect((await app.request("/__preflight")).status).toBe(200);
  const rpc = await app.request("/api/sessions/session/plugin-rpc", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      kind: "action",
      pluginId: id,
      action: "probe",
      payload: {},
    }),
  });
  expect(rpc.status).toBe(202);
  expect((await rpc.json()).pending.action).toBe("probe");
  const listed = await (await app.request("/api/plugins")).json();
  expect(listed.items).toContainEqual(
    expect.objectContaining({
      id,
      trust: {
        source: "https://github.com/example/plugins",
        trustedSource: true,
        integrity: "verified",
        autoApproved: true,
      },
    }),
  );
  expect(
    await (await app.request("/api/install/plugins")).json(),
  ).toMatchObject({
    items: [{ id, integrity: "verified", trustedSource: true }],
  });
});
it.each([
  "untrusted",
  "removed",
  "edited-after-boot",
  "no-snapshot",
  "no-receipt",
])("prompts for %s", async (condition) => {
  const fixture = await build({
    trusted: condition !== "untrusted",
    snapshot: condition === "no-snapshot" ? null : undefined,
  });
  if (condition === "removed")
    expect((await put({ "trust.sources": [] })).status).toBe(200);
  if (condition === "edited-after-boot")
    await writeFile(
      path.join(fixture.directory, "server.js"),
      code + "\n// edit after verification",
    );
  if (condition === "no-receipt") await rm(fixture.receiptPath);
  await pending(await enable());
  expect((await store().getSession("session"))?.activePlugins).toEqual([]);
  if (condition === "edited-after-boot")
    expect(
      await (await app.request("/api/install/plugins")).json(),
    ).toMatchObject({ items: [{ integrity: "modified" }] });
});
it.each(["hook", "http", "tool", "serverCode"])(
  "prompts when current %s exceeds the saved snapshot",
  async (dimension) => {
    const fixture = await build();
    const saved = await readReceipt(fixture.directory);
    // An update's approved content has the current declarations but carries the smaller previous snapshot.
    const changed = saved.capabilities;
    if (!changed) throw new Error("Missing snapshot");
    const entry = api!.registry.get(id);
    if (!entry?.packageManifest) throw new Error("Missing manifest");
    const plugin = entry.packageManifest.plugin;
    if (dimension === "hook")
      api!.registry.register({
        ...entry,
        packageManifest: {
          ...entry.packageManifest,
          plugin: {
            ...plugin,
            contributes: {
              ...plugin.contributes,
              hooks: [{ event: "PreToolUse", enforce: "pre" }],
            },
          },
        },
      });
    if (dimension === "http")
      api!.registry.register({
        ...entry,
        packageManifest: {
          ...entry.packageManifest,
          plugin: {
            ...plugin,
            permissions: { http: [{ origin: "https://new.test" }] },
          },
        },
      });
    if (dimension === "tool")
      api!.registry.register({
        ...entry,
        packageManifest: {
          ...entry.packageManifest,
          plugin: {
            ...plugin,
            contributes: { ...plugin.contributes, tools: ["new"] },
          },
        },
      });
    if (dimension === "serverCode")
      await writeFile(
        fixture.receiptPath,
        JSON.stringify({
          ...saved,
          capabilities: { ...changed, serverCode: false },
        }),
      );
    await pending(await enable());
  },
);
it.each([true, false])(
  "normal approval refreshes only trusted snapshots (trusted=%s)",
  async (trusted) => {
    const fixture = await build({ snapshot: null, trusted });
    const before = await readFile(fixture.receiptPath, "utf8");
    const approvalId = await pending(await enable());
    const approved = await app.request(
      `/api/approvals/${approvalId}/decision`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ decision: "allow", scope: "session" }),
      },
    );
    expect(approved.status, await approved.clone().text()).toBe(200);
    if (trusted)
      expect((await readReceipt(fixture.directory)).capabilities).toEqual(
        fixture.capabilities,
      );
    else expect(await readFile(fixture.receiptPath, "utf8")).toBe(before);
    await session("second");
    expect((await enable("second")).status).toBe(trusted ? 200 : 202);
  },
);
it("removing a source takes effect for a new session without restarting", async () => {
  await build();
  expect((await enable()).status).toBe(200);
  expect((await put({ "trust.sources": [] })).status).toBe(200);
  await session("second");
  await pending(await enable("second"));
});
it("keeps hosted operator checks before the trusted-source grant", async () => {
  await build({ hosted: true });
  const denied = await enable("session", { "x-session-token": "owner" });
  expect(denied.status).toBe(401);
  expect(await denied.json()).toMatchObject({
    code: "operator_token_required",
  });
  const allowed = await enable("session", {
    "x-session-token": "owner",
    authorization: "Bearer operator",
  });
  expect(allowed.status, await allowed.clone().text()).toBe(200);
  const write = await put(
    { "trust.sources": ["another"] },
    { authorization: "Bearer operator" },
  );
  expect(write.status).toBe(403);
  expect(await write.json()).toMatchObject({
    code: "server_settings_operator_only",
  });
});
it("validates personal settings, reports source/settable, and preserves the list on Origin:null", async () => {
  await build({ trusted: false });
  expect(
    (await put({ "trust.sources": [" Example/Plugins ", "example/plugins"] }))
      .status,
  ).toBe(200);
  expect(await (await app.request(serverSettingPath)).json()).toMatchObject({
    settings: {
      "trust.sources": {
        value: ["example/plugins"],
        source: "setting",
        settable: true,
      },
    },
  });
  const invalid = await put({ "trust.sources": ["bad/"] });
  expect(invalid.status).toBe(400);
  expect(await invalid.json()).toMatchObject({
    code: "invalid_server_setting_value",
  });
  expect((await put({ "trust.sources": [] }, { origin: "null" })).status).toBe(
    403,
  );
  expect(api!.trustedSources.policy()).toEqual(["example/plugins"]);
});
it("requires the configured desktop token", async () => {
  await build({ desktop: true });
  expect((await put({ "trust.sources": [] })).status).toBe(401);
  expect(
    (await put({ "trust.sources": [] }, { authorization: "Bearer desktop" }))
      .status,
  ).toBe(200);
});
it("locks an environment-fixed policy with 409", async () => {
  vi.stubEnv("COVEL_TRUSTED_SOURCES", "example/plugins");
  await build();
  expect(await (await app.request(serverSettingPath)).json()).toMatchObject({
    settings: {
      "trust.sources": {
        value: ["example/plugins"],
        source: "env",
        settable: false,
      },
    },
  });
  const response = await put({ "trust.sources": [] });
  expect(response.status).toBe(409);
  expect(await response.json()).toMatchObject({ code: "server_setting_fixed" });
});

it("executes a restored active session's first turn without enabling its trusted plugin again", async () => {
  await build({
    restoredActive: true,
    manifest: {
      ...baseline,
      runtime: {
        schedule: { stage: "pre-turn", trigger: { type: "auto" } },
        function: { handler: "./handler.mjs" },
      },
    },
    files: {
      "server.js": code,
      "handler.mjs":
        'export default async () => ({ outcome: "success", value: { restored: true } });',
    },
  });
  const entryBefore = api!.registry.get(id);
  expect(api!.trustedSources.implicitGrant({ pluginId: id })).toBe(true);
  const response = await app.request("/api/actions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      requestId: crypto.randomUUID(),
      sessionId: "session",
      type: "send_message",
      payload: { content: "Continue after restart." },
    }),
  });
  const text = await response.text();
  expect(response.status, text).toBe(200);
  const events = parseJsonFrames<{
    type: string;
    payload: Record<string, unknown>;
  }>(text);
  expect(
    events.filter(
      (event) =>
        event.type === "runtime.failed" || event.type === "error.occurred",
    ),
  ).toEqual([]);
  expect(events).toContainEqual(
    expect.objectContaining({
      type: "runtime.completed",
      payload: expect.objectContaining({ runtimeId: id }),
    }),
  );
  expect(events).toContainEqual(
    expect.objectContaining({
      type: "execution.completed",
      payload: expect.objectContaining({
        runtimeCount: 1,
        resultCount: 1,
        committed: true,
      }),
    }),
  );
  expect(api!.registry.get(id)).not.toBe(entryBefore);
  expect(api!.trustedSources.implicitGrant({ pluginId: id })).toBe(true);
  expect((await store().getSession("session"))?.completedPlayerTurns).toBe(1);
});

it.each(["runtime:reset", "covel:plugin-server-code", "event:reset"])(
  "rejects the internal approval name %s as an ordinary RPC action even when a handler exists",
  async (action) => {
    await build();
    expect((await enable()).status).toBe(200);
    const handler = vi.fn(async () => ({ reset: true }));
    // Simulate a host registration outside the entry API. Public dispatch
    // must reject internal keys even if a handler has reached the registry.
    api!.app.post("/__register-action", (c) => {
      c.get("rpcRegistry").registerPluginHandler(
        id,
        action,
        handler,
        {},
        "community",
      );
      return c.json({ ok: true });
    });
    expect(
      (await api!.app.request("/__register-action", { method: "POST" })).status,
    ).toBe(200);
    const response = await app.request("/api/sessions/session/plugin-rpc", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        kind: "action",
        pluginId: id,
        action,
        payload: { target: "player", reset: true },
      }),
    });
    expect(response.status, await response.clone().text()).toBe(400);
    expect(await response.json()).toMatchObject({
      error: expect.stringContaining("reserved"),
    });
    expect(handler).not.toHaveBeenCalled();
  },
);
