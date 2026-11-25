import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { configureOutboundProxy } from "@covel/ai-provider";
import { resetOutboundProxyForTests } from "@covel/ai-provider/testing";
import { readRuntimeEnv } from "@covel/shared";

vi.mock("node:dns/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:dns/promises")>();
  return {
    ...actual,
    lookup: vi.fn(async (hostname: string, options?: { all?: boolean }) => {
      if (hostname === "device.example") {
        const entry = { address: "93.184.216.34", family: 4 as const };
        return options?.all ? [entry] : entry;
      }
      return actual.lookup(hostname, options as never);
    }),
  };
});
import { createMemoryStore } from "@covel/store/memory";
import { deriveHostProfile, type HostProfile } from "../../src/host-profile.js";
import {
  bootstrapApi,
  type ApiBootstrapResult,
} from "../../src/routes/api/bootstrap.js";
import { closeTestApi } from "../helpers/close-api.js";

const md = (frontmatter: Record<string, unknown>) =>
  `---\n${JSON.stringify(frontmatter)}\n---\nPhase 3 integration plugin fixture`;

async function writePluginDir(
  parentDir: string,
  pluginId: string,
  manifest: Record<string, unknown>,
  files: Record<string, string>,
): Promise<string> {
  const dir = path.join(parentDir, pluginId);
  await mkdir(dir, { recursive: true });
  await writeFile(
    path.join(dir, "PLUGIN.md"),
    md({ id: pluginId, description: `Fixture ${pluginId}`, ...manifest }),
    "utf8",
  );
  for (const [relPath, content] of Object.entries(files)) {
    const target = path.join(dir, relPath);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, content, "utf8");
  }
  return dir;
}

describe("plugin app actions, declarative config flows, loopback & net.authProxy", () => {
  let root: string;
  let builtinDir: string;
  let userDir: string;
  let covelHome: string;
  let store: ReturnType<typeof createMemoryStore>;
  let api: ApiBootstrapResult | undefined;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "covel-app-flows-"));
    builtinDir = path.join(root, "builtin");
    userDir = path.join(root, "user");
    covelHome = path.join(root, "home");
    await mkdir(builtinDir, { recursive: true });
    await mkdir(userDir, { recursive: true });
    await mkdir(covelHome, { recursive: true });
    store = createMemoryStore();
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    await resetOutboundProxyForTests();
    await closeTestApi(api);
    api = undefined;
    await store.close();
    await rm(root, { recursive: true, force: true });
  });

  async function bootServer(hostProfile?: HostProfile) {
    await closeTestApi(api);
    api = await bootstrapApi({
      pluginsDir: builtinDir,
      pluginsDirs: [builtinDir, userDir],
      covelHome,
      store,
      storeBackend: "memory",
      hostProfile:
        hostProfile ??
        deriveHostProfile(readRuntimeEnv(), { storeBackend: "sqlite" }),
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

  async function grantPlugin(
    booted: ApiBootstrapResult,
    pluginId: string,
    decisions: Record<string, "allow" | "deny">,
  ) {
    const summary = await booted.permissionService.inspectPlugin(pluginId);
    await booted.permissionService.setPluginGrant(pluginId, {
      decisions,
      expectedDigest: summary.contentDigest!,
    });
  }

  function postJson(
    url: string,
    body?: unknown,
    extraHeaders?: Record<string, string>,
  ) {
    const headers: Record<string, string> = {
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
      ...extraHeaders,
    };
    return api!.app.request(url, {
      method: "POST",
      headers: Object.keys(headers).length > 0 ? headers : undefined,
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
  }

  it("handles app actions with lazy onAppAction:* activation, Zod validation, and L1/L3 requiredCapabilities gates", async () => {
    await writePluginDir(
      userDir,
      "action-probe",
      {
        apiVersion: 2,
        scope: "instance",
        activationEvents: ["onAppAction:secret-echo"],
        permissions: { secrets: true },
        contributes: { appActions: ["secret-echo"] },
        entry: "./server.mjs",
      },
      {
        "server.mjs": `
          export default function (covel) {
            const z = covel.toolkit.z;
            covel.registerAppAction(
              "secret-echo",
              async (input, ctx) => {
                await ctx.secrets.set("marker", { seen: input.label });
                return { saved: input.label, hostId: ctx.hostId };
              },
              {
                inputSchema: z.object({ label: z.string().min(2) }),
                outputSchema: z.object({ saved: z.string(), hostId: z.string() }),
                requiredCapabilities: ["secrets.own"],
              },
            );
          }
        `,
      },
    );

    const booted = await bootServer();
    expect(booted.instancePlugins.isActivated("action-probe")).toBe(false);

    // Denied without L3 grant
    const deniedNoGrant = await postJson(
      "/api/plugins/action-probe/actions/secret-echo",
      { label: "ok" },
    );
    expect(deniedNoGrant.status).toBe(403);
    expect(booted.instancePlugins.isActivated("action-probe")).toBe(false);

    // Grant instanceScope + communityCode, but leave secrets.own unset -> 403 on requiredCapabilities
    await grantPlugin(booted, "action-probe", {
      "plugin.communityCode": "allow",
      "plugin.instanceScope": "allow",
    });

    const missingCap = await postJson(
      "/api/plugins/action-probe/actions/secret-echo",
      { label: "hello" },
    );
    expect(missingCap.status).toBe(403);
    expect(booted.instancePlugins.isActivated("action-probe")).toBe(true);

    // Grant secrets.own -> validate Zod input error (400) and undeclared action (404), then succeed (200)
    await grantPlugin(booted, "action-probe", {
      "plugin.communityCode": "allow",
      "plugin.instanceScope": "allow",
      "secrets.own": "allow",
    });

    const undeclared = await postJson(
      "/api/plugins/action-probe/actions/missing-action",
      {},
    );
    expect(undeclared.status).toBe(404);

    const invalidInput = await postJson(
      "/api/plugins/action-probe/actions/secret-echo",
      { label: "x" },
    );
    expect(invalidInput.status).toBe(400);
    expect(((await invalidInput.json()) as { code: string }).code).toBe(
      "invalid_input",
    );

    const okRes = await postJson(
      "/api/plugins/action-probe/actions/secret-echo",
      { label: "my-key" },
    );
    expect(okRes.status).toBe(200);
    expect(await okRes.json()).toEqual({
      ok: true,
      result: { saved: "my-key", hostId: booted.hostId },
    });
    expect(
      (await booted.secretVault.get("action-probe", "marker"))?.value,
    ).toEqual({ seen: "my-key" });

    // L1 disabled host rejects app action cleanly (401 unauthenticated, 403 even with operator token)
    const hosted = deriveHostProfile(
      {
        ...readRuntimeEnv(),
        deploymentTier: "demo",
        desktopRestToken: "op-secret",
      },
      { storeBackend: "sqlite" },
    );
    await bootServer(hosted);
    const hostedUnauth = await postJson(
      "/api/plugins/action-probe/actions/secret-echo",
      { label: "blocked" },
    );
    expect(hostedUnauth.status).toBe(401);
    const hostedRes = await postJson(
      "/api/plugins/action-probe/actions/secret-echo",
      { label: "blocked" },
      { authorization: "Bearer op-secret" },
    );
    expect(hostedRes.status).toBe(403);
  });

  it("executes form + secret config flow without leaking secrets in snapshots", async () => {
    await writePluginDir(
      userDir,
      "form-flow-plugin",
      {
        apiVersion: 2,
        scope: "instance",
        activationEvents: ["onFlow:api-key"],
        permissions: { secrets: true },
        contributes: { flows: ["api-key"] },
        entry: "./server.mjs",
      },
      {
        "server.mjs": `
          export default function (covel) {
            covel.registerConfigFlow("api-key", {
              requiredCapabilities: ["secrets.own"],
              async start() {
                return {
                  kind: "form",
                  stepId: "enter-key",
                  title: "Configure Key",
                  fields: [
                    { name: "apiKey", label: "API Key", type: "secret", required: true },
                  ],
                };
              },
              async step(input, ctx) {
                const token = String(input.data?.apiKey ?? "");
                await ctx.secrets.set("api-key", { token });
                return {
                  kind: "done",
                  title: "Saved",
                  summary: { configured: true },
                };
              },
            });
          }
        `,
      },
    );

    const booted = await bootServer();
    await grantPlugin(booted, "form-flow-plugin", {
      "plugin.communityCode": "allow",
      "plugin.instanceScope": "allow",
      "secrets.own": "allow",
    });

    const startRes = await postJson(
      "/api/plugins/form-flow-plugin/flows/api-key/start",
    );
    expect(startRes.status).toBe(200);
    const started = (await startRes.json()) as {
      ok: true;
      run: {
        runId: string;
        status: string;
        step: { kind: string; stepId: string };
      };
    };
    expect(started.run.status).toBe("active");
    expect(started.run.step.kind).toBe("form");

    const stepRes = await postJson(
      `/api/plugins/form-flow-plugin/flows/api-key/runs/${started.run.runId}/step`,
      {
        stepId: started.run.step.stepId,
        data: { apiKey: "super-secret-token-xyz" },
      },
    );
    expect(stepRes.status).toBe(200);

    const getRes = await booted.app.request(
      `/api/plugins/form-flow-plugin/flows/api-key/runs/${started.run.runId}`,
    );
    expect(getRes.status).toBe(200);
    const runBody = await getRes.text();
    expect(runBody).not.toContain("super-secret-token-xyz");
    expect(JSON.parse(runBody)).toMatchObject({
      ok: true,
      run: { status: "completed", step: { kind: "done" } },
    });
    expect(
      (await booted.secretVault.get("form-flow-plugin", "api-key"))?.value,
    ).toEqual({ token: "super-secret-token-xyz" });
  });

  it("supports browser loopback auto-completion, manual paste fallback, and DELETE cancellation", async () => {
    await writePluginDir(
      userDir,
      "browser-flow-plugin",
      {
        apiVersion: 2,
        scope: "instance",
        activationEvents: ["onFlow:oauth"],
        permissions: {
          secrets: true,
          loopbackCallback: { path: "/oauth/cb", ports: "ephemeral" },
        },
        contributes: { flows: ["oauth"] },
        entry: "./server.mjs",
      },
      {
        "server.mjs": `
          export default function (covel) {
            covel.registerConfigFlow("oauth", {
              requiredCapabilities: ["secrets.own", "net.loopbackCallback"],
              async start(_input, ctx) {
                const session = await ctx.startLoopbackCallback();
                const authUrl = new URL("https://auth.example/authorize");
                authUrl.searchParams.set("redirect_uri", session.callbackUrl);
                authUrl.searchParams.set("state", session.state);
                return {
                  kind: "browser",
                  stepId: "oauth-wait",
                  title: "Sign in via browser",
                  authorizeUrl: authUrl.toString(),
                  completion: "loopback-or-paste",
                  callbackUrl: session.callbackUrl,
                };
              },
              async step(input, ctx) {
                const pasted = new URL(input.callbackUrl);
                const code = pasted.searchParams.get("code") ?? "missing";
                await ctx.secrets.set("oauth", { token: "tok-" + code });
                return { kind: "done", title: "Authorized" };
              },
            });
          }
        `,
      },
    );

    const booted = await bootServer();
    await grantPlugin(booted, "browser-flow-plugin", {
      "plugin.communityCode": "allow",
      "plugin.instanceScope": "allow",
      "secrets.own": "allow",
      "net.loopbackCallback": "allow",
    });

    // (a) Real localhost loopback callback auto-advances the run and closes the port
    const runA = (
      await (
        await postJson("/api/plugins/browser-flow-plugin/flows/oauth/start")
      ).json()
    ).run as {
      runId: string;
      step: { stepId: string; callbackUrl: string; authorizeUrl: string };
    };
    expect(runA.step.callbackUrl).toMatch(
      /^http:\/\/127\.0\.0\.1:\d+\/oauth\/cb$/,
    );

    const browserState = new URL(runA.step.authorizeUrl).searchParams.get(
      "state",
    );
    const browserHit = await fetch(
      `${runA.step.callbackUrl}?code=loop42&state=${browserState}`,
    );
    expect(browserHit.status).toBe(200);

    // Wait briefly for serialized auto-advance to commit
    let snapshotA: { status: string; step: { kind: string } } | undefined;
    for (let i = 0; i < 20; i++) {
      const check = (
        await (
          await booted.app.request(
            `/api/plugins/browser-flow-plugin/flows/oauth/runs/${runA.runId}`,
          )
        ).json()
      ).run as { status: string; step: { kind: string } };
      snapshotA = check;
      if (check.status === "completed") break;
      await new Promise((r) => setTimeout(r, 15));
    }
    expect(snapshotA?.status).toBe("completed");
    expect(snapshotA?.step.kind).toBe("done");
    expect(
      (await booted.secretVault.get("browser-flow-plugin", "oauth"))?.value,
    ).toEqual({ token: "tok-loop42" });
    await expect(fetch(runA.step.callbackUrl)).rejects.toThrow();

    // (b) Remote URL paste completes the flow and closes the unused loopback listener
    const runB = (
      await (
        await postJson("/api/plugins/browser-flow-plugin/flows/oauth/start")
      ).json()
    ).run as {
      runId: string;
      step: { stepId: string; callbackUrl: string; authorizeUrl: string };
    };
    const pasteState = new URL(runB.step.authorizeUrl).searchParams.get(
      "state",
    );
    const invalidPaste = await postJson(
      `/api/plugins/browser-flow-plugin/flows/oauth/runs/${runB.runId}/step`,
      {
        stepId: runB.step.stepId,
        callbackUrl: `${runB.step.callbackUrl}?code=paste99`,
      },
    );
    expect(invalidPaste.status).toBe(400);
    expect(await invalidPaste.json()).toMatchObject({
      code: "invalid_callback_state",
    });
    const pasteRes = await postJson(
      `/api/plugins/browser-flow-plugin/flows/oauth/runs/${runB.runId}/step`,
      {
        stepId: runB.step.stepId,
        callbackUrl: `${runB.step.callbackUrl}?code=paste99&state=${pasteState}`,
      },
    );
    expect(pasteRes.status).toBe(200);
    expect(await pasteRes.json()).toMatchObject({
      ok: true,
      run: { status: "completed", step: { kind: "done" } },
    });
    expect(
      (await booted.secretVault.get("browser-flow-plugin", "oauth"))?.value,
    ).toEqual({ token: "tok-paste99" });
    await new Promise((r) => setTimeout(r, 25));
    await expect(fetch(runB.step.callbackUrl)).rejects.toThrow();

    // (c) DELETE cancels an active run and frees its loopback listener immediately
    const runC = (
      await (
        await postJson("/api/plugins/browser-flow-plugin/flows/oauth/start")
      ).json()
    ).run as { runId: string; step: { callbackUrl: string } };
    const delRes = await booted.app.request(
      `/api/plugins/browser-flow-plugin/flows/oauth/runs/${runC.runId}`,
      { method: "DELETE" },
    );
    expect(delRes.status).toBe(200);
    expect(await delRes.json()).toMatchObject({
      ok: true,
      run: { status: "cancelled" },
    });
    await new Promise((r) => setTimeout(r, 25));
    await expect(fetch(runC.step.callbackUrl)).rejects.toThrow();

    // (d) Closing the loopback listener and returning `completion: "paste"` detaches the host state check
    await writePluginDir(
      userDir,
      "paste-fallback-plugin",
      {
        apiVersion: 2,
        scope: "instance",
        activationEvents: ["onFlow:oauth-paste"],
        permissions: { secrets: true, loopbackCallback: { path: "/oauth/cb" } },
        contributes: { flows: ["oauth-paste"] },
        entry: "./server.mjs",
      },
      {
        "server.mjs": `
          export default function (covel) {
            const expectedState = new Map();
            covel.registerConfigFlow("oauth-paste", {
              requiredCapabilities: ["secrets.own"],
              async start(_input, ctx) {
                const loopback = await ctx.startLoopbackCallback();
                await loopback.close();
                const pluginState = "plugin-own-state-" + ctx.runId;
                expectedState.set(ctx.runId, pluginState);
                return {
                  kind: "browser",
                  stepId: "await-paste",
                  title: "Paste callback",
                  authorizeUrl: "https://auth.example/authorize?state=" + pluginState,
                  completion: "paste",
                  callbackUrl: "http://127.0.0.1:1455/oauth/cb",
                };
              },
              async step(input, ctx) {
                const raw = String(input.callbackUrl ?? "");
                const url = new URL(raw.startsWith("http") ? raw : "http://" + raw);
                if (url.searchParams.get("state") !== expectedState.get(ctx.runId)) {
                  return { kind: "error", code: "state_mismatch", title: "Mismatch", message: "Bad state", retryable: true };
                }
                await ctx.secrets.set("oauth", { token: "tok-" + url.searchParams.get("code") });
                return { kind: "done", title: "Authorized" };
              },
            });
          }
        `,
      },
    );
    const bootedPaste = await bootServer();
    await grantPlugin(bootedPaste, "paste-fallback-plugin", {
      "plugin.communityCode": "allow",
      "plugin.instanceScope": "allow",
      "secrets.own": "allow",
      "net.loopbackCallback": "allow",
    });
    const pasteOnlyStart = (
      await (
        await postJson(
          "/api/plugins/paste-fallback-plugin/flows/oauth-paste/start",
        )
      ).json()
    ).run as {
      runId: string;
      step: { stepId: string; authorizeUrl: string; completion: string };
    };
    expect(pasteOnlyStart.step.completion).toBe("paste");
    const pluginOwnState = new URL(
      pasteOnlyStart.step.authorizeUrl,
    ).searchParams.get("state");
    const pasteOnlyDone = await postJson(
      `/api/plugins/paste-fallback-plugin/flows/oauth-paste/runs/${pasteOnlyStart.runId}/step`,
      {
        stepId: pasteOnlyStart.step.stepId,
        callbackUrl: `localhost:1455/oauth/cb?code=manual77&state=${pluginOwnState}`,
      },
    );
    expect(pasteOnlyDone.status).toBe(200);
    expect(await pasteOnlyDone.json()).toMatchObject({
      ok: true,
      run: { status: "completed", step: { kind: "done" } },
    });
    expect(
      (await bootedPaste.secretVault.get("paste-fallback-plugin", "oauth"))
        ?.value,
    ).toEqual({ token: "tok-manual77" });
  });

  it("supports device polling, import maxBytes enforcement, and confirm steps", async () => {
    let deviceApproved = false;
    const origFetch = globalThis.fetch;
    vi.stubGlobal(
      "fetch",
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url =
          typeof input === "string"
            ? input
            : input instanceof URL
              ? input.href
              : input.url;
        if (url === "https://device.example/token") {
          return new Response(
            JSON.stringify(
              deviceApproved
                ? { status: "approved", access_token: "dev-tok" }
                : { status: "pending" },
            ),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }
        return origFetch(input, init);
      },
    );

    await writePluginDir(
      userDir,
      "device-import-plugin",
      {
        apiVersion: 2,
        scope: "instance",
        activationEvents: ["onFlow:device-flow", "onFlow:import-flow"],
        permissions: {
          secrets: true,
          http: [{ origin: "https://device.example", methods: ["POST"] }],
        },
        contributes: { flows: ["device-flow", "import-flow"] },
        entry: "./server.mjs",
      },
      {
        "server.mjs": `
          export default function (covel) {
            covel.registerConfigFlow("device-flow", {
              requiredCapabilities: ["secrets.own"],
              async start() {
                return {
                  kind: "device",
                  stepId: "poll-device",
                  title: "Enter code",
                  userCode: "ABCD-1234",
                  verificationUri: "https://device.example/activate",
                  intervalSec: 1,
                };
              },
              async poll(ctx) {
                const res = await ctx.http.fetchWithRetry("https://device.example/token", {
                  method: "POST",
                  maxRetries: 0,
                });
                const body = await res.json();
                if (body.status !== "approved") return null;
                await ctx.secrets.set("device", { token: body.access_token });
                return { kind: "done", title: "Device authorized" };
              },
              async step() {
                return { kind: "done", title: "Done" };
              },
            });

            covel.registerConfigFlow("import-flow", {
              async start() {
                return {
                  kind: "import",
                  stepId: "upload-json",
                  title: "Import Bundle",
                  maxBytes: 64,
                };
              },
              async step(input, ctx) {
                if (input.stepId === "upload-json") {
                  await ctx.instanceData.set("import", "preview", String(input.data?.content ?? ""));
                  return {
                    kind: "confirm",
                    stepId: "confirm-import",
                    title: "Apply Bundle?",
                    details: [{ label: "Status", value: "ready" }],
                  };
                }
                await ctx.instanceData.set("import", "committed", true);
                return { kind: "done", title: "Imported" };
              },
            });
          }
        `,
      },
    );

    const booted = await bootServer();
    await grantPlugin(booted, "device-import-plugin", {
      "plugin.communityCode": "allow",
      "plugin.instanceScope": "allow",
      "secrets.own": "allow",
    });

    // Device poll flow
    const deviceStart = (
      await (
        await postJson(
          "/api/plugins/device-import-plugin/flows/device-flow/start",
        )
      ).json()
    ).run as { runId: string; step: { kind: string; userCode: string } };
    expect(deviceStart.step.kind).toBe("device");

    const pollPending = (
      await (
        await booted.app.request(
          `/api/plugins/device-import-plugin/flows/device-flow/runs/${deviceStart.runId}`,
        )
      ).json()
    ).run as { status: string; step: { kind: string } };
    expect(pollPending.status).toBe("active");
    expect(pollPending.step.kind).toBe("device");

    deviceApproved = true;
    const pollDone = (
      await (
        await booted.app.request(
          `/api/plugins/device-import-plugin/flows/device-flow/runs/${deviceStart.runId}`,
        )
      ).json()
    ).run as { status: string; step: { kind: string } };
    expect(pollDone.status).toBe("completed");
    expect(pollDone.step.kind).toBe("done");
    expect(
      (await booted.secretVault.get("device-import-plugin", "device"))?.value,
    ).toEqual({ token: "dev-tok" });

    // Import maxBytes (413) + Confirm -> Done
    const impStart = (
      await (
        await postJson(
          "/api/plugins/device-import-plugin/flows/import-flow/start",
        )
      ).json()
    ).run as { runId: string; step: { stepId: string } };

    const tooBig = await postJson(
      `/api/plugins/device-import-plugin/flows/import-flow/runs/${impStart.runId}/step`,
      { stepId: impStart.step.stepId, data: { content: "x".repeat(128) } },
    );
    expect(tooBig.status).toBe(413);
    expect(((await tooBig.json()) as { code: string }).code).toBe(
      "payload_too_large",
    );

    const impConfirm = (
      await (
        await postJson(
          `/api/plugins/device-import-plugin/flows/import-flow/runs/${impStart.runId}/step`,
          { stepId: impStart.step.stepId, data: { content: "ok" } },
        )
      ).json()
    ).run as { step: { kind: string; stepId: string } };
    expect(impConfirm.step.kind).toBe("confirm");

    const impDone = await postJson(
      `/api/plugins/device-import-plugin/flows/import-flow/runs/${impStart.runId}/step`,
      { stepId: impConfirm.step.stepId, data: { confirmed: true } },
    );
    expect(impDone.status).toBe(200);
    expect(await impDone.json()).toMatchObject({
      ok: true,
      run: { status: "completed", step: { kind: "done" } },
    });
    expect(
      (
        await store.getInstanceData(
          "device-import-plugin",
          "import",
          "committed",
        )
      )?.value,
    ).toBe(true);
  });

  it("enforces bounded net.authProxy (ProxyAgent, origin allowlist, 302 refusal, L1/L3 denial)", async () => {
    const fetchSpy = vi.fn(async (input: RequestInfo | URL) => {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.href
            : input.url;
      if (url === "https://auth-target.example/token") {
        return new Response(JSON.stringify({ proxied: true }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (url === "https://auth-target.example/redir") {
        return new Response("redir", {
          status: 302,
          headers: { location: "https://evil.example/" },
        });
      }
      return new Response("not-found", { status: 404 });
    });
    vi.stubGlobal("fetch", fetchSpy);
    configureOutboundProxy({ mode: "http", url: "http://127.0.0.1:7890" });

    await writePluginDir(
      userDir,
      "auth-proxy-plugin",
      {
        apiVersion: 2,
        scope: "instance",
        activationEvents: ["onAppAction:call-proxy"],
        permissions: {
          authProxy: true,
          http: [{ origin: "https://auth-target.example", methods: ["POST"] }],
        },
        contributes: { appActions: ["call-proxy"] },
        entry: "./server.mjs",
      },
      {
        "server.mjs": `
          export default function (covel) {
            covel.registerAppAction("call-proxy", async (input, ctx) => {
              const res = await ctx.http.fetchWithRetry(input.url, {
                method: input.method ?? "POST",
                proxy: input.proxy ?? "instance-auth",
                redirect: input.redirect,
                maxRetries: 0,
              });
              return await res.json();
            });
          }
        `,
      },
    );

    const booted = await bootServer();
    // Allowed instanceScope, WITHOUT net.authProxy -> call fails closed
    await grantPlugin(booted, "auth-proxy-plugin", {
      "plugin.communityCode": "allow",
      "plugin.instanceScope": "allow",
    });
    const deniedProxy = await postJson(
      "/api/plugins/auth-proxy-plugin/actions/call-proxy",
      { url: "https://auth-target.example/token" },
    );
    expect(deniedProxy.status).toBe(500);
    expect(fetchSpy).not.toHaveBeenCalled();

    // Grant net.authProxy -> succeeds through ProxyAgent dispatcher
    await grantPlugin(booted, "auth-proxy-plugin", {
      "plugin.communityCode": "allow",
      "plugin.instanceScope": "allow",
      "net.authProxy": "allow",
    });

    const okProxy = await postJson(
      "/api/plugins/auth-proxy-plugin/actions/call-proxy",
      { url: "https://auth-target.example/token" },
    );
    expect(okProxy.status).toBe(200);
    expect(await okProxy.json()).toEqual({
      ok: true,
      result: { proxied: true },
    });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const firstCallInit = (
      fetchSpy.mock.calls[0] as unknown[] | undefined
    )?.[1] as
      | {
          dispatcher?: { constructor?: { name?: string } };
          redirect?: string;
        }
      | undefined;
    expect(firstCallInit?.dispatcher?.constructor?.name).toBe("ProxyAgent");
    expect(firstCallInit?.redirect).toBe("manual");

    // Undeclared origin refused
    const badOrigin = await postJson(
      "/api/plugins/auth-proxy-plugin/actions/call-proxy",
      { url: "https://undeclared.example/token" },
    );
    expect(badOrigin.status).toBe(500);
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    // 3xx redirect refused even when caller supplies redirect: "manual"
    const redirRefused = await postJson(
      "/api/plugins/auth-proxy-plugin/actions/call-proxy",
      {
        url: "https://auth-target.example/redir",
        redirect: "manual",
      },
    );
    expect(redirRefused.status).toBe(500);
  });

  it("activates only the target plugin for shared action/flow names and sets Cache-Control: no-store on flows (M-10)", async () => {
    const manifest = (name: string) => ({
      apiVersion: 2,
      scope: "instance",
      activationEvents: ["onAppAction:shared-act", "onFlow:shared-flow"],
      contributes: { appActions: ["shared-act"], flows: ["shared-flow"] },
      entry: "./server.mjs",
      description: name,
    });
    const entryCode = (label: string) => `
      export default function (covel) {
        covel.registerAppAction("shared-act", async () => ({ owner: "${label}" }));
        covel.registerConfigFlow("shared-flow", {
          start: async () => ({ kind: "done", title: "${label}" }),
          step: async () => ({ kind: "done", title: "${label}" }),
        });
      }
    `;
    await writePluginDir(userDir, "shared-a", manifest("A"), {
      "server.mjs": entryCode("A"),
    });
    await writePluginDir(userDir, "shared-b", manifest("B"), {
      "server.mjs": entryCode("B"),
    });

    const booted = await bootServer();
    for (const pid of ["shared-a", "shared-b"]) {
      await grantPlugin(booted, pid, {
        "plugin.communityCode": "allow",
        "plugin.instanceScope": "allow",
      });
    }

    expect(booted.instancePlugins.isActivated("shared-a")).toBe(false);
    expect(booted.instancePlugins.isActivated("shared-b")).toBe(false);

    const actRes = await postJson("/api/plugins/shared-a/actions/shared-act");
    expect(actRes.status).toBe(200);
    expect(await actRes.json()).toEqual({ ok: true, result: { owner: "A" } });
    expect(booted.instancePlugins.isActivated("shared-a")).toBe(true);
    expect(booted.instancePlugins.isActivated("shared-b")).toBe(false);

    const flowRes = await postJson(
      "/api/plugins/shared-a/flows/shared-flow/start",
    );
    expect(flowRes.status).toBe(200);
    expect(flowRes.headers.get("cache-control")).toBe("no-store");
    expect(booted.instancePlugins.isActivated("shared-b")).toBe(false);
  });

  it("times out hanging app actions with 504 app_action_timeout (M-10)", async () => {
    const { createPluginAppActionRoutes } =
      await import("../../src/routes/api/plugin-app-actions.js");
    const { createAppActionRegistry } =
      await import("../../src/routes/api/bootstrap/app-actions.js");
    await writePluginDir(
      userDir,
      "slow-action-plugin",
      {
        apiVersion: 2,
        scope: "instance",
        contributes: { appActions: ["hang"] },
        entry: "./server.mjs",
      },
      {
        "server.mjs": `
          export default function (covel) {
            covel.registerAppAction("hang", () => new Promise(() => {}));
          }
        `,
      },
    );
    const booted = await bootServer();
    await grantPlugin(booted, "slow-action-plugin", {
      "plugin.communityCode": "allow",
      "plugin.instanceScope": "allow",
    });

    const appActions = createAppActionRegistry();
    appActions.register(
      "slow-action-plugin",
      "hang",
      () => new Promise(() => {}),
      {},
      "community",
    );
    const routeApp = createPluginAppActionRoutes({
      registry: booted.registry,
      store,
      hostId: booted.hostId,
      secretVault: booted.secretVault,
      appActions,
      instancePlugins: booted.instancePlugins,
      permissionService: booted.permissionService,
      trustedSources: booted.trustedSources,
      actionTimeoutMs: 40,
    });
    const res = await routeApp.request("/slow-action-plugin/actions/hang", {
      method: "POST",
    });
    expect(res.status).toBe(504);
    expect(await res.json()).toMatchObject({ code: "app_action_timeout" });
  });

  it("enforces maxConcurrentRuns during async start(), aborts/cleans up on close(), and cleans half-registered entries on replacePlugin rollback (M-07)", async () => {
    const { createConfigFlowEngine } =
      await import("../../src/routes/api/bootstrap/config-flows.js");
    const { createAppActionRegistry } =
      await import("../../src/routes/api/bootstrap/app-actions.js");

    // 1. replacePlugin rollback cleans up half-registered actions & flows.
    const actions = createAppActionRegistry();
    actions.register("p1", "old", async () => ({}), {}, "community");
    expect(() =>
      actions.replacePlugin("p1", () => {
        actions.register("p1", "new-half", async () => ({}), {}, "community");
        throw new Error("boom");
      }),
    ).toThrow("boom");
    expect(actions.get("p1", "old")).toBeDefined();
    expect(actions.get("p1", "new-half")).toBeUndefined();

    const engine = createConfigFlowEngine({ maxConcurrentRuns: 1 });
    engine.register("p1", "old-flow", {
      start: async () => ({ kind: "done", title: "ok" }),
      step: async () => ({ kind: "done", title: "ok" }),
    });
    expect(() =>
      engine.replacePlugin("p1", () => {
        engine.register("p1", "half-flow", {
          start: async () => ({ kind: "done", title: "ok" }),
          step: async () => ({ kind: "done", title: "ok" }),
        });
        throw new Error("flow-boom");
      }),
    ).toThrow("flow-boom");
    expect(engine.get("p1", "old-flow")).toBeDefined();
    expect(engine.get("p1", "half-flow")).toBeUndefined();

    // 2. Concurrent start() cannot bypass maxConcurrentRuns, and close() aborts in-flight start & closes its loopback.
    let releaseStart!: () => void;
    let startSignalAborted = false;
    let loopbackClosed = false;
    engine.register("p1", "slow-start", {
      start: async (_input, ctx) => {
        ctx.signal.addEventListener("abort", () => {
          startSignalAborted = true;
        });
        await ctx.startLoopbackCallback?.();
        await new Promise<void>((resolve) => {
          releaseStart = resolve;
        });
        return { kind: "done", title: "late" };
      },
      step: async () => ({ kind: "done", title: "ok" }),
    });

    const ctxFactory = ({
      pluginId,
      flowId,
      runId,
      signal,
      onLoopbackStarted,
    }: Parameters<
      Parameters<typeof engine.start>[3]
    >[0]) =>
      ({
        pluginId,
        flowId,
        runId,
        signal,
        startLoopbackCallback: async () => {
          const fakeSession = {
            callbackUrl: "http://127.0.0.1:9999/cb",
            state: "st",
            port: 9999,
            canAccept: () => true,
            waitForCallback: () => new Promise<never>(() => {}),
            close: async () => {
              loopbackClosed = true;
            },
          };
          onLoopbackStarted(fakeSession);
          return fakeSession;
        },
      }) as unknown as ReturnType<Parameters<typeof engine.start>[3]>;

    const firstStart = engine.start("p1", "slow-start", {}, ctxFactory);
    // Let firstStart reserve the slot and enter definition.start().
    await new Promise((r) => setTimeout(r, 10));

    await expect(
      engine.start("p1", "slow-start", {}, ctxFactory),
    ).rejects.toMatchObject({ status: 429, code: "too_many_flow_runs" });

    // Closing while start() is in flight must abort its signal, close its loopback, and reject firstStart.
    await engine.close();
    expect(startSignalAborted).toBe(true);
    expect(loopbackClosed).toBe(true);
    releaseStart();
    await expect(firstStart).rejects.toMatchObject({
      status: 409,
      code: "flow_engine_closed",
    });
  });
});
