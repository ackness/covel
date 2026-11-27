import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  defaultSessionSeats,
  readRuntimeEnv,
  type SessionPluginsResponse,
} from "@covel/shared";
import { createMemoryStore } from "@covel/store/memory";
import {
  bootstrapApi,
  type ApiBootstrapResult,
} from "../../src/routes/api/bootstrap.js";
import { deriveHostProfile } from "../../src/host-profile.js";
import { closeTestApi } from "../helpers/close-api.js";
import { id as fixtureId, md, packageFixture } from "../trust/fixtures.js";

let root: string;
let builtinDir: string;
let userDir: string;
let store: ReturnType<typeof createMemoryStore>;
let api: ApiBootstrapResult | undefined;

const baselineManifest = {
  entry: "./server.js",
  contributes: { actions: ["probe"] },
  runtime: { schedule: { trigger: { type: "manual" } } },
};

const baselineCode =
  'export default c => { c.registerRpc("probe", async () => ({ ok: true })); };';

async function bootServer() {
  await closeTestApi(api);
  api = await bootstrapApi({
    pluginsDir: builtinDir,
    pluginsDirs: [builtinDir, userDir],
    store,
    storeBackend: "memory",
    hostProfile: deriveHostProfile(readRuntimeEnv(), {
      storeBackend: "sqlite",
    }),
    llmAdapter: {
      generate: async () => ({
        content: "ok",
        toolCalls: [],
        finishReason: "stop",
        usage: { inputTokens: 1, outputTokens: 1 },
      }),
    },
  });
  return api;
}

async function seedSession(
  sessionId = "perm-session",
  activePlugins: string[] = [],
) {
  const now = new Date().toISOString();
  await store.createSession({
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
    },
  });
}

function req(
  url: string,
  method = "GET",
  body?: unknown,
  headers: Record<string, string> = {},
) {
  return api!.app.request(url, {
    method,
    headers: {
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
      ...headers,
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}

describe("permissions governance API (/api/permissions/*)", () => {
  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "covel-permissions-api-"));
    builtinDir = path.join(root, "builtin");
    userDir = path.join(root, "user");
    await mkdir(builtinDir);
    await mkdir(userDir);
    store = createMemoryStore();
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("DEPLOYMENT_TIER", "self");
    vi.stubEnv("COVEL_DESKTOP_REST_TOKEN", "");
    vi.stubEnv("COVEL_TRUSTED_SOURCES", "");
    vi.stubEnv("COVEL_PERMISSIONS_POLICY", "");
    vi.stubEnv("COVEL_DISABLED_CAPABILITIES", "");
    vi.stubEnv("COVEL_MEDIA_TOKEN_SECRET", "");
    vi.stubEnv("COVEL_USER_PLUGINS_DIR", userDir);
  });

  afterEach(async () => {
    await closeTestApi(api);
    api = undefined;
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    await rm(root, { recursive: true, force: true });
  });

  it("manages L2 snapshot and instance policy, enforces auto-policy limits, env lock, and shared-host refusal", async () => {
    await bootServer();
    const initial = await req("/api/permissions/snapshot");
    expect(initial.status).toBe(200);
    const snapBody = (await initial.json()) as {
      deploymentForm: string;
      capabilities: Record<string, string>;
      policy: {
        overrides: Record<string, string>;
        source: string;
        settable: boolean;
        effective: Record<string, { effective: string }>;
      };
    };
    expect(snapBody.deploymentForm).toBe("personal");
    expect(snapBody.capabilities["plugin.communityCode"]).toBe("enabled");
    expect(snapBody.policy.source).toBe("default");
    expect(snapBody.policy.settable).toBe(true);
    expect(snapBody.policy.effective["plugin.communityCode"]?.effective).toBe(
      "ask",
    );

    const updated = await req("/api/permissions/policy", "PUT", {
      policy: {
        "compute.sandboxWorker": "allow",
        "net.httpDeclared": "deny",
      },
    });
    expect(updated.status).toBe(200);
    expect(await updated.json()).toMatchObject({
      policy: {
        overrides: {
          "compute.sandboxWorker": "allow",
          "net.httpDeclared": "deny",
        },
        source: "setting",
        settable: true,
      },
    });

    // Reject unknown capability and disallow "allow" on high-risk autoPolicy:false keys.
    expect(
      (
        await req("/api/permissions/policy", "PUT", {
          policy: { "unknown.cap": "deny" },
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await req("/api/permissions/policy", "PUT", {
          policy: { "plugin.communityCode": "allow" },
        })
      ).status,
    ).toBe(400);

    // Clearing policy with null restores defaults.
    const cleared = await req("/api/permissions/policy", "PUT", {
      policy: null,
    });
    expect(cleared.status).toBe(200);
    expect(await cleared.json()).toMatchObject({
      policy: { overrides: {}, source: "default" },
    });

    // Env lock prevents runtime modification with 409 server_setting_fixed.
    vi.stubEnv("COVEL_PERMISSIONS_POLICY", "net.httpDeclared=deny");
    const locked = await req("/api/permissions/policy", "PUT", {
      policy: { "app.scheduler": "deny" },
    });
    expect(locked.status).toBe(409);
    expect(await locked.json()).toMatchObject({ code: "server_setting_fixed" });

    // Shared hosted tier refuses L2 policy writes with 403 even with operator token.
    vi.stubEnv("COVEL_PERMISSIONS_POLICY", "");
    vi.stubEnv("DEPLOYMENT_TIER", "demo");
    vi.stubEnv("COVEL_MEDIA_TOKEN_SECRET", "media-secret");
    vi.stubEnv("COVEL_DESKTOP_REST_TOKEN", "operator-secret");
    await bootServer();
    const hostedWrite = await req(
      "/api/permissions/policy",
      "PUT",
      { policy: { "net.httpDeclared": "deny" } },
      { Authorization: "Bearer operator-secret" },
    );
    expect(hostedWrite.status).toBe(403);
    expect(await hostedWrite.json()).toMatchObject({
      code: "server_settings_operator_only",
    });
  });

  it("persists L3 grant across restart, checks TOCTOU digest, and invalidates on file change or escalation", async () => {
    await mkdir(path.join(builtinDir, "core-probe"), { recursive: true });
    await writeFile(
      path.join(builtinDir, "core-probe", "PLUGIN.md"),
      md({ id: "core-probe", description: "Builtin probe" }),
    );
    await packageFixture(userDir, {
      manifest: baselineManifest,
      files: { "server.js": baselineCode },
      trusted: false,
      snapshot: null,
    });
    await bootServer();
    await seedSession("s-persist");

    // Builtin plugins reject persistent grant mutations with 409 builtin_plugin_immutable.
    const builtinGrantRes = await req(
      "/api/permissions/plugins/core-probe/grants",
      "PUT",
      { decisions: { "plugin.declarative": "deny" } },
    );
    expect(builtinGrantRes.status).toBe(409);
    expect(await builtinGrantRes.json()).toMatchObject({
      code: "builtin_plugin_immutable",
    });

    const listRes = await req("/api/permissions/plugins");
    expect(listRes.status).toBe(200);
    const { items } = (await listRes.json()) as {
      items: Array<{
        pluginId: string;
        contentDigest: string | null;
        grantStatus: string;
        tier: number;
      }>;
    };
    const plugin = items.find((item) => item.pluginId === fixtureId);
    expect(plugin?.tier).toBe(3);
    expect(plugin?.grantStatus).toBe("none");
    expect(plugin?.contentDigest).toBeTruthy();

    // TOCTOU mismatch rejects stale expectedDigest with 409.
    const mismatch = await req(
      `/api/permissions/plugins/${fixtureId}/grants`,
      "PUT",
      {
        decisions: { "plugin.communityCode": "allow" },
        expectedDigest: "sha256:stale-digest",
      },
    );
    expect(mismatch.status).toBe(409);
    expect(await mismatch.json()).toMatchObject({
      code: "plugin_digest_mismatch",
    });

    // Valid digest persists grant.
    const granted = await req(
      `/api/permissions/plugins/${fixtureId}/grants`,
      "PUT",
      {
        decisions: { "plugin.communityCode": "allow" },
        expectedDigest: plugin!.contentDigest!,
      },
    );
    expect(granted.status).toBe(200);
    expect(await granted.json()).toMatchObject({
      ok: true,
      plugin: { grantStatus: "valid" },
    });

    // Reboot server on the same DataStore — L3 persistent grant survives.
    await bootServer();
    const enableRes = await req(
      `/api/sessions/s-persist/plugins/${fixtureId}`,
      "PUT",
    );
    expect(enableRes.status, await enableRes.clone().text()).toBe(200);

    const sessionPlugins = (await (
      await req("/api/sessions/s-persist/plugins")
    ).json()) as SessionPluginsResponse;
    const item = sessionPlugins.items.find((p) => p.id === fixtureId);
    expect(item?.serverCodeApproved).toBe(true);
    expect(item?.serverCodeApprovedBy).toBe("persistent-grant");

    // Mutate code file without changing declared capabilities -> stale-digest.
    await writeFile(
      path.join(userDir, fixtureId, "server.js"),
      'export default c => { c.registerRpc("probe", async () => ({ changed: true })); };',
    );
    expect((await req(`/api/plugins/${fixtureId}/reload`, "POST")).status).toBe(
      200,
    );

    const afterCodeEdit = (await (
      await req("/api/permissions/plugins")
    ).json()) as { items: Array<{ pluginId: string; grantStatus: string }> };
    expect(
      afterCodeEdit.items.find((p) => p.pluginId === fixtureId)?.grantStatus,
    ).toBe("stale-digest");

    // Stale digest re-prompts with 202 instead of silently trusting edited code.
    await seedSession("s-reprompt");
    const staleEnable = await req(
      `/api/sessions/s-reprompt/plugins/${fixtureId}`,
      "PUT",
    );
    expect(staleEnable.status).toBe(202);

    // Refresh grant on current code, then escalate capabilities -> capability-escalated.
    const refreshedDigest = (
      (await (await req("/api/permissions/plugins")).json()) as {
        items: Array<{ pluginId: string; contentDigest: string }>;
      }
    ).items.find((p) => p.pluginId === fixtureId)!.contentDigest;
    expect(
      (
        await req(`/api/permissions/plugins/${fixtureId}/grants`, "PUT", {
          decisions: { "plugin.communityCode": "allow" },
          expectedDigest: refreshedDigest,
        })
      ).status,
    ).toBe(200);

    await writeFile(
      path.join(userDir, fixtureId, "PLUGIN.md"),
      md({
        id: fixtureId,
        description: "Probe",
        entry: "./server.js",
        contributes: { actions: ["probe", "extra-action"] },
        runtime: { schedule: { trigger: { type: "manual" } } },
      }),
    );
    expect((await req(`/api/plugins/${fixtureId}/reload`, "POST")).status).toBe(
      200,
    );
    const afterEscalation = (await (
      await req("/api/permissions/plugins")
    ).json()) as { items: Array<{ pluginId: string; grantStatus: string }> };
    expect(
      afterEscalation.items.find((p) => p.pluginId === fixtureId)?.grantStatus,
    ).toBe("capability-escalated");
    expect(
      (await req(`/api/sessions/s-reprompt/plugins/${fixtureId}`, "PUT"))
        .status,
    ).toBe(202);
  });

  it("keeps sticky L3 deny across trusted-source and file edits, overrides L4 with L2 policy, and clears L4 grants on revoke", async () => {
    vi.stubEnv("COVEL_TRUSTED_SOURCES", "example/plugins");
    await packageFixture(userDir, {
      manifest: baselineManifest,
      files: { "server.js": baselineCode },
      trusted: true,
    });
    await bootServer();
    await seedSession("s-gov");
    const listedTrust = async () => {
      const body = await (await req("/api/permissions/plugins")).json();
      return body.items.find(
        (item: { pluginId: string }) => item.pluginId === fixtureId,
      );
    };
    expect(await listedTrust()).toMatchObject({
      trustedSource: true,
      sourceAutoApproved: true,
    });

    // Sticky deny beats trusted-source even after file changes make digest stale.
    expect(
      (
        await req(`/api/permissions/plugins/${fixtureId}/grants`, "PUT", {
          decisions: { "plugin.communityCode": "deny" },
        })
      ).status,
    ).toBe(200);
    await writeFile(
      path.join(userDir, fixtureId, "server.js"),
      'export default c => { c.registerRpc("probe", async () => ({ v: 2 })); };',
    );
    expect((await req(`/api/plugins/${fixtureId}/reload`, "POST")).status).toBe(
      200,
    );

    expect(await listedTrust()).toMatchObject({
      trustedSource: true,
      sourceAutoApproved: false,
    });

    const stickyDenied = await req(
      `/api/sessions/s-gov/plugins/${fixtureId}`,
      "PUT",
    );
    expect(stickyDenied.status).toBe(403);
    expect(await stickyDenied.json()).toMatchObject({
      code: "capability_denied_by_grant",
    });

    // Clear L3 grant + disable trusted source to test L4 approval + L2 deny + DELETE /grants.
    vi.stubEnv("COVEL_TRUSTED_SOURCES", "");
    await bootServer();
    expect(
      (await req(`/api/permissions/plugins/${fixtureId}/grants`, "DELETE"))
        .status,
    ).toBe(200);

    await seedSession("s-l4", [fixtureId]);
    const prompt1 = await req(`/api/sessions/s-l4/plugins/${fixtureId}`, "PUT");
    expect(prompt1.status).toBe(202);
    const { approvalId } = (await prompt1.json()) as { approvalId: string };
    expect(
      (
        await req(`/api/approvals/${approvalId}/decision`, "POST", {
          decision: "allow",
          scope: "session",
        })
      ).status,
    ).toBe(200);

    // GET /api/sessions/:id/approvals lists active L4 grants alongside pending items.
    const approvalsList = (await (
      await req("/api/sessions/s-l4/approvals")
    ).json()) as {
      items: unknown[];
      grants: Array<{ pluginId: string; action: string }>;
    };
    expect(approvalsList.grants).toEqual([
      { pluginId: fixtureId, action: "covel:plugin-server-code" },
    ]);

    // L2 policy deny blocks even an active L4 session grant with 403 capability_denied_by_policy.
    expect(
      (
        await req("/api/permissions/policy", "PUT", {
          policy: { "plugin.communityCode": "deny" },
        })
      ).status,
    ).toBe(200);
    const blockedByL2 = await req("/api/sessions/s-l4/plugin-rpc", "POST", {
      kind: "action",
      pluginId: fixtureId,
      action: "probe",
      payload: {},
    });
    expect(blockedByL2.status).toBe(403);
    expect(await blockedByL2.json()).toMatchObject({
      code: "capability_denied_by_policy",
    });

    // DELETE /api/permissions/plugins/:id/grants revokes cached L4 session grants too.
    expect(
      (await req("/api/permissions/policy", "PUT", { policy: null })).status,
    ).toBe(200);
    const revokeRes = await req(
      `/api/permissions/plugins/${fixtureId}/grants`,
      "DELETE",
    );
    expect(revokeRes.status).toBe(200);
    expect(await revokeRes.json()).toMatchObject({
      ok: true,
      pluginId: fixtureId,
      revokedSessionGrants: 1,
    });
    expect(
      await (await req("/api/sessions/s-l4/approvals")).json(),
    ).toMatchObject({ grants: [] });
  });

  it("enforces L1 disabled ceilings against grant writes on hosted tiers and blocks denied declarative plugins", async () => {
    await packageFixture(userDir, {
      manifest: {
        description: "Declarative only",
        contributes: {
          settings: [
            {
              key: "tone",
              type: "toggle",
              label: "Tone",
              default: false,
            },
          ],
        },
      },
      trusted: false,
      snapshot: null,
    });

    // Hosted tier locks plugin.providerSource to disabled and checks host.config / plugin.community.
    vi.stubEnv("DEPLOYMENT_TIER", "demo");
    vi.stubEnv("COVEL_MEDIA_TOKEN_SECRET", "media-secret");
    vi.stubEnv("COVEL_DESKTOP_REST_TOKEN", "operator-secret");
    await bootServer();

    expect(
      (
        await req(
          `/api/permissions/plugins/${fixtureId}/grants`,
          "PUT",
          { decisions: { "plugin.providerSource": "allow" } },
          { Authorization: "Bearer operator-secret" },
        )
      ).status,
    ).toBe(403);

    // Back to personal tier: verify declarative community plugin can be denied by L2 & L3.
    vi.stubEnv("DEPLOYMENT_TIER", "self");
    vi.stubEnv("COVEL_DESKTOP_REST_TOKEN", "");
    vi.stubEnv("COVEL_MEDIA_TOKEN_SECRET", "");
    await bootServer();
    await seedSession("s-decl");

    expect(
      (
        await req("/api/permissions/policy", "PUT", {
          policy: { "plugin.declarative": "deny" },
        })
      ).status,
    ).toBe(200);
    const l2Denied = await req(
      `/api/sessions/s-decl/plugins/${fixtureId}`,
      "PUT",
    );
    expect(l2Denied.status).toBe(403);
    expect(await l2Denied.json()).toMatchObject({
      code: "capability_denied_by_policy",
    });

    expect(
      (await req("/api/permissions/policy", "PUT", { policy: null })).status,
    ).toBe(200);
    expect(
      (
        await req(`/api/permissions/plugins/${fixtureId}/grants`, "PUT", {
          decisions: { "plugin.declarative": "deny" },
        })
      ).status,
    ).toBe(200);
    const l3Denied = await req(
      `/api/sessions/s-decl/plugins/${fixtureId}`,
      "PUT",
    );
    expect(l3Denied.status).toBe(403);
    expect(await l3Denied.json()).toMatchObject({
      code: "capability_denied_by_grant",
    });
  });

  it("rejects reserved exec.localBridge mutations and enforces plugin.globalAutoEnable across L1/L2", async () => {
    await mkdir(path.join(builtinDir, "helper-auto"), { recursive: true });
    await writeFile(
      path.join(builtinDir, "helper-auto", "PLUGIN.md"),
      md({
        id: "helper-auto",
        description: "Optional auto-enabled helper",
        globalSessionDefault: "optional",
      }),
    );
    await packageFixture(userDir, {
      manifest: baselineManifest,
      files: { "server.js": baselineCode },
      trusted: false,
      snapshot: null,
    });
    await bootServer();

    // Reserved capability rejects policy changes and persistent grants.
    expect(
      (
        await req("/api/permissions/policy", "PUT", {
          policy: { "exec.localBridge": "ask" },
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await req(`/api/permissions/plugins/${fixtureId}/grants`, "PUT", {
          decisions: { "exec.localBridge": "allow" },
        })
      ).status,
    ).toBe(400);

    // Personal tier with default L2 allow auto-enables optional helpers on new sessions.
    const sAuto = await req("/api/sessions", "POST", { locale: "en-US" });
    expect(sAuto.status).toBe(201);
    const sAutoBody = (await sAuto.json()) as { activePlugins: string[] };
    expect(sAutoBody.activePlugins).toContain("helper-auto");

    // Denying plugin.globalAutoEnable at L2 stops automatic helper attachment.
    expect(
      (
        await req("/api/permissions/policy", "PUT", {
          policy: { "plugin.globalAutoEnable": "deny" },
        })
      ).status,
    ).toBe(200);
    const sDenied = await req("/api/sessions", "POST", { locale: "en-US" });
    expect(sDenied.status).toBe(201);
    const sDeniedBody = (await sDenied.json()) as { activePlugins: string[] };
    expect(sDeniedBody.activePlugins).not.toContain("helper-auto");

    // Hosted tier disables plugin.globalAutoEnable at L1 even when L2 policy is cleared.
    expect(
      (await req("/api/permissions/policy", "PUT", { policy: null })).status,
    ).toBe(200);
    vi.stubEnv("DEPLOYMENT_TIER", "demo");
    vi.stubEnv("COVEL_MEDIA_TOKEN_SECRET", "media-secret");
    vi.stubEnv("COVEL_DESKTOP_REST_TOKEN", "operator-secret");
    await bootServer();
    const sHosted = await req(
      "/api/sessions",
      "POST",
      { locale: "en-US" },
      { Authorization: "Bearer operator-secret" },
    );
    expect(sHosted.status).toBe(201);
    const sHostedBody = (await sHosted.json()) as { activePlugins: string[] };
    expect(sHostedBody.activePlugins).not.toContain("helper-auto");
  });

  it("enforces session.bridgeWrite on plugin-rpc and plugin-data writes and runtime.highRiskTools on tool execution", async () => {
    await mkdir(path.join(builtinDir, "bridge-probe"), { recursive: true });
    await writeFile(
      path.join(builtinDir, "bridge-probe", "PLUGIN.md"),
      md({
        id: "bridge-probe",
        description: "Bridge and tool probe",
        entry: "./server.js",
        contributes: {
          actions: ["ping"],
          tools: ["risky-write", "safe-read"],
        },
      }),
    );
    await writeFile(
      path.join(builtinDir, "bridge-probe", "server.js"),
      `export default (covel) => {
        const tk = covel.toolkit;
        covel.registerRpc("ping", async () => ({ pong: true }));
        covel.registerTool(tk.tool({
          name: "risky-write",
          description: "Non-idempotent write tool",
          parameters: tk.z.object({}),
          execute: async () => ({ mutated: true }),
        }));
        covel.registerTool(tk.tool({
          name: "safe-read",
          description: "Read-only query tool",
          annotations: { readOnly: true, idempotent: true, concurrencySafe: true },
          parameters: tk.z.object({}),
          execute: async () => ({ ok: true }),
        }));
      };`,
    );
    await bootServer();
    const toolCtx = {
      sessionId: "s-bridge",
      turnId: "t-1",
      pluginId: "bridge-probe",
      runtimeId: "bridge-probe",
    };
    // Register helper route before Hono builds its router matcher on first request.
    api!.app.post("/__test-exec-tool", async (c) => {
      const { name } = (await c.req.json()) as { name: string };
      const res = await c
        .get("toolExecutor")
        .execute({ toolCallId: `tc-${name}`, name, arguments: "{}" }, toolCtx);
      return c.json(res);
    });
    await seedSession("s-bridge", ["bridge-probe"]);

    // Baseline: bridge writes and tools succeed.
    expect(
      (
        await req("/api/sessions/s-bridge/plugin-rpc", "POST", {
          kind: "action",
          pluginId: "bridge-probe",
          action: "ping",
          payload: {},
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await req(
          "/api/sessions/s-bridge/plugin-data/bridge-probe/notes/k1",
          "PUT",
          { value: { hello: 1 } },
        )
      ).status,
    ).toBe(200);

    // Deny session.bridgeWrite at L2 -> blocks plugin RPC and plugin-data PUT/DELETE.
    expect(
      (
        await req("/api/permissions/policy", "PUT", {
          policy: { "session.bridgeWrite": "deny" },
        })
      ).status,
    ).toBe(200);
    const rpcBlocked = await req("/api/sessions/s-bridge/plugin-rpc", "POST", {
      kind: "action",
      pluginId: "bridge-probe",
      action: "ping",
      payload: {},
    });
    expect(rpcBlocked.status).toBe(403);
    expect(await rpcBlocked.json()).toMatchObject({
      code: "capability_denied_by_policy",
    });

    const dataPutBlocked = await req(
      "/api/sessions/s-bridge/plugin-data/bridge-probe/notes/k2",
      "PUT",
      { value: { hello: 2 } },
    );
    expect(dataPutBlocked.status).toBe(403);
    expect(await dataPutBlocked.json()).toMatchObject({
      code: "capability_denied_by_policy",
    });

    const dataDelBlocked = await req(
      "/api/sessions/s-bridge/plugin-data/bridge-probe/notes/k1",
      "DELETE",
    );
    expect(dataDelBlocked.status).toBe(403);

    // Deny runtime.highRiskTools at L2 -> blocks non-idempotent tool while keeping read-only tool allowed.
    expect(
      (
        await req("/api/permissions/policy", "PUT", {
          policy: { "runtime.highRiskTools": "deny" },
        })
      ).status,
    ).toBe(200);
    const deniedTool = (await (
      await req("/__test-exec-tool", "POST", { name: "risky-write" })
    ).json()) as { success: boolean; approvalStatus?: string; result: string };
    expect(deniedTool.success).toBe(false);
    expect(deniedTool.approvalStatus).toBe("policy-denied");
    expect(deniedTool.result).toContain("runtime.highRiskTools");

    const allowedTool = (await (
      await req("/__test-exec-tool", "POST", { name: "safe-read" })
    ).json()) as { success: boolean; approvalStatus?: string };
    expect(allowedTool.success).toBe(true);
    expect(allowedTool.approvalStatus).toBe("auto-allowed");
  });

  it("enforces operator-only plugin.communityCode on hosted session reads and live net.httpDeclared in function runtimes", async () => {
    vi.stubEnv("COVEL_TRUSTED_SOURCES", "example/plugins");
    await packageFixture(userDir, {
      manifest: {
        description: "HTTP function runtime",
        permissions: {
          http: [{ origin: "https://api.declared.test", methods: ["GET"] }],
        },
        runtime: {
          schedule: { trigger: { type: "manual" } },
          permissions: {
            http: [{ origin: "https://api.declared.test", methods: ["GET"] }],
          },
          function: { handler: "./handler.mjs" },
        },
      },
      files: {
        "handler.mjs": `export default async (ctx) => {
          await ctx.utils.fetchWithRetry("https://api.declared.test/ping");
          return { output: { fetched: true } };
        };`,
      },
      trusted: true,
    });
    const fetchSpy = vi.fn(async () => new Response("ok", { status: 200 }));
    await closeTestApi(api);
    api = await bootstrapApi({
      pluginsDir: builtinDir,
      pluginsDirs: [builtinDir, userDir],
      store,
      storeBackend: "memory",
      hostProfile: deriveHostProfile(readRuntimeEnv(), {
        storeBackend: "sqlite",
      }),
      pluginUtils: {
        validateBaseUrl: () => ({ ok: true }),
        fetchWithRetry: fetchSpy as never,
      },
      llmAdapter: {
        generate: async () => ({
          content: "ok",
          toolCalls: [],
          finishReason: "stop",
          usage: { inputTokens: 1, outputTokens: 1 },
        }),
      },
    });
    await seedSession("s-http", [fixtureId]);

    // Default net.httpDeclared=allow lets the function runtime reach its declared origin.
    const okRpc = await req("/api/sessions/s-http/plugin-rpc", "POST", {
      kind: "runtime",
      pluginId: fixtureId,
      runtimeId: fixtureId,
      payload: {},
    });
    expect(okRpc.status, await okRpc.clone().text()).toBe(200);
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    // Denying net.httpDeclared at L2 immediately blocks the function runtime's declared HTTP call.
    expect(
      (
        await req("/api/permissions/policy", "PUT", {
          policy: { "net.httpDeclared": "deny" },
        })
      ).status,
    ).toBe(200);
    const blockedRpc = await req("/api/sessions/s-http/plugin-rpc", "POST", {
      kind: "runtime",
      pluginId: fixtureId,
      runtimeId: fixtureId,
      payload: {},
    });
    expect(blockedRpc.status).toBe(200);
    const blockedBody = (await blockedRpc.json()) as {
      runtimeResults?: Array<{ status: string; error?: string }>;
    };
    const runtimeOutcome = blockedBody.runtimeResults?.[0];
    expect(runtimeOutcome?.status).toBe("failed");
    expect(runtimeOutcome?.error).toContain("net.httpDeclared");
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    // Hosted tier: plugin.communityCode is operator-only, so non-operator session reads
    // never treat a trusted-source community plugin as authorized or serverCodeApproved.
    expect(
      (await req("/api/permissions/policy", "PUT", { policy: null })).status,
    ).toBe(200);
    vi.stubEnv("DEPLOYMENT_TIER", "demo");
    vi.stubEnv("COVEL_MEDIA_TOKEN_SECRET", "media-secret");
    vi.stubEnv("COVEL_DESKTOP_REST_TOKEN", "operator-secret");
    await bootServer();
    const created = await req(
      "/api/sessions",
      "POST",
      { locale: "en-US", plugins: [fixtureId] },
      { Authorization: "Bearer operator-secret" },
    );
    expect(created.status).toBe(201);
    const { id: hostedSessionId, ownerToken } = (await created.json()) as {
      id: string;
      ownerToken: string;
    };

    const nonOpPlugins = (await (
      await req(`/api/sessions/${hostedSessionId}/plugins`, "GET", undefined, {
        "x-session-token": ownerToken,
      })
    ).json()) as SessionPluginsResponse;
    const nonOpItem = nonOpPlugins.items.find((p) => p.id === fixtureId);
    expect(nonOpItem?.serverCodeApproved).toBe(false);
    expect(nonOpItem?.active).toBe(false);

    const opPlugins = (await (
      await req(`/api/sessions/${hostedSessionId}/plugins`, "GET", undefined, {
        "x-session-token": ownerToken,
        Authorization: "Bearer operator-secret",
      })
    ).json()) as SessionPluginsResponse;
    const opItem = opPlugins.items.find((p) => p.id === fixtureId);
    expect(opItem?.serverCodeApproved).toBe(true);
  });

  it("enforces plugin.declarative L2 ask and deny across action preflight, runtime RPC, and session fork", async () => {
    await packageFixture(userDir, {
      manifest: {
        description: "Declarative agent runtime",
        runtime: {
          schedule: { trigger: { type: "manual" } },
        },
      },
      trusted: false,
      snapshot: null,
    });
    await bootServer();
    await seedSession("s-decl-exec", [fixtureId]);

    // L2 deny blocks runtime RPC directly even when the declarative plugin is already active.
    expect(
      (
        await req("/api/permissions/policy", "PUT", {
          policy: { "plugin.declarative": "deny" },
        })
      ).status,
    ).toBe(200);
    const rpcDenied = await req(
      "/api/sessions/s-decl-exec/plugin-rpc",
      "POST",
      {
        kind: "runtime",
        pluginId: fixtureId,
        runtimeId: fixtureId,
        payload: {},
      },
    );
    expect(rpcDenied.status).toBe(403);
    expect(await rpcDenied.json()).toMatchObject({
      code: "capability_denied_by_policy",
    });

    // Session fork excludes a denied declarative plugin from the child session.
    const snapRes = await req("/api/sessions/s-decl-exec/snapshots", "POST", {
      label: "before-fork",
    });
    expect(snapRes.status).toBe(201);
    const snapJson = (await snapRes.json()) as {
      id?: string;
      snapshot?: { id: string };
    };
    const snapshotId = snapJson.snapshot?.id ?? snapJson.id;
    expect(snapshotId).toBeTruthy();
    const forkRes = await req("/api/sessions/s-decl-exec/fork", "POST", {
      fromSnapshotId: snapshotId,
    });
    expect(forkRes.status, await forkRes.clone().text()).toBe(201);
    const forked = (await forkRes.json()) as {
      id?: string;
      sessionId?: string;
    };
    const childId = forked.sessionId ?? forked.id;
    expect(childId).toBeTruthy();
    const childSession = await store.getSession(childId!);
    expect(childSession?.activePlugins).not.toContain(fixtureId);

    // L2 ask does not silently auto-admit declarative plugins without approval.
    expect(
      (
        await req("/api/permissions/policy", "PUT", {
          policy: { "plugin.declarative": "ask" },
        })
      ).status,
    ).toBe(200);
    await seedSession("s-decl-ask");
    const askEnable = await req(
      `/api/sessions/s-decl-ask/plugins/${fixtureId}`,
      "PUT",
    );
    expect(askEnable.status).toBe(202);
  });
});
