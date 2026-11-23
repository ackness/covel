import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readRuntimeEnv } from "@covel/shared";
import { createMemoryStore } from "@covel/store/memory";
import { createAiStack } from "../../src/ai-setup.js";
import { deriveHostProfile, type HostProfile } from "../../src/host-profile.js";
import { mountApiRoutes } from "../../src/host-routes.js";
import {
  bootstrapApi,
  type ApiBootstrapResult,
} from "../../src/routes/api/bootstrap.js";
import { createAppEventDispatcher } from "../../src/routes/api/bootstrap/app-events.js";
import { createAppScheduler } from "../../src/routes/api/bootstrap/app-scheduler.js";
import { buildUiSpecsResponse } from "../../src/routes/misc-api/ui-specs.js";
import { Hono } from "hono";
import { hostProfileMiddleware } from "../../src/host-profile.js";
import { closeTestApi } from "../helpers/close-api.js";

const md = (frontmatter: Record<string, unknown>) =>
  `---\n${JSON.stringify(frontmatter)}\n---\nPlatform v2 test fixture`;

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

describe("AppEvents, AppScheduler, and Instance UI Slot Gating", () => {
  let root: string;
  let builtinDir: string;
  let userDir: string;
  let covelHome: string;
  let store: ReturnType<typeof createMemoryStore>;
  let api: ApiBootstrapResult | undefined;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "covel-app-events-sched-"));
    builtinDir = path.join(root, "builtin");
    userDir = path.join(root, "user");
    covelHome = path.join(root, "home");
    await mkdir(builtinDir, { recursive: true });
    await mkdir(userDir, { recursive: true });
    await mkdir(covelHome, { recursive: true });
    store = createMemoryStore();
  });

  afterEach(async () => {
    await closeTestApi(api);
    api = undefined;
    await store.close();
    await rm(root, { recursive: true, force: true });
  });

  async function bootServer(hostProfile?: HostProfile) {
    await closeTestApi(api);
    const profile =
      hostProfile ??
      deriveHostProfile(readRuntimeEnv(), { storeBackend: "sqlite" });
    api = await bootstrapApi({
      pluginsDir: builtinDir,
      pluginsDirs: [builtinDir, userDir],
      covelHome,
      store,
      storeBackend: "memory",
      hostProfile: profile,
      llmAdapter: {
        generate: async () => ({
          content: "ok",
          toolCalls: [],
          finishReason: "stop",
          usage: { inputTokens: 1, outputTokens: 1 },
        }),
      },
    });
    const app = new Hono();
    app.use("*", hostProfileMiddleware(profile));
    mountApiRoutes(app, { api, ai: createAiStack(), store, apiKeys: {} });
    return { api, app };
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

  it("dispatches channel bridge phases to admitted instance providers", async () => {
    await writePluginDir(
      builtinDir,
      "channel-adapter",
      {
        apiVersion: 2,
        scope: "instance",
        activationEvents: ["onAppAction:render"],
        contributes: { appActions: ["render"] },
        entry: "./server.mjs",
      },
      {
        "server.mjs": `
          export default function (covel) {
            covel.registerAppAction("render", (input) => covel.dispatchChannelBridge(input));
          }
        `,
      },
    );
    await writePluginDir(
      userDir,
      "channel-renderer",
      {
        apiVersion: 2,
        scope: "instance",
        activationEvents: ["onExtension:channel.bridge@1"],
        contributes: {
          extensions: [{ point: "channel.bridge@1", id: "render" }],
        },
        entry: "./server.mjs",
      },
      {
        "server.mjs": `
          export default function (covel) {
            covel.provideExtension("channel.bridge@1", "render", {
              handler(input) {
                return { handled: true, formattedText: input.story.toUpperCase() };
              },
            });
          }
        `,
      },
    );
    const { api: booted, app } = await bootServer();
    const render = () =>
      app.request("/api/plugins/channel-adapter/actions/render", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          phase: "beforeRender",
          channelId: "fixture",
          sessionId: "session-1",
          turnId: "turn-1",
          story: "hello",
        }),
      });
    expect(await (await render()).json()).toMatchObject({
      ok: true,
      result: [],
    });
    await grantPlugin(booted, "channel-renderer", {
      "plugin.communityCode": "allow",
      "plugin.instanceScope": "allow",
      "channel.bridge": "allow",
    });
    expect(await (await render()).json()).toMatchObject({
      ok: true,
      result: [
        {
          handled: true,
          formattedText: "HELLO",
          providerPluginId: "channel-renderer",
        },
      ],
    });
  });

  it("isolates AppEventDispatcher payloads, catches failing handlers, and respects lazy activation gating", async () => {
    await writePluginDir(
      userDir,
      "event-observer",
      {
        apiVersion: 2,
        scope: "instance",
        activationEvents: [
          "onAppEvent:SessionCreated",
          "onAppEvent:SessionDeleted",
          "onAppEvent:WorldInstalled",
          "onAppEvent:WorldRemoved",
        ],
        contributes: {
          appEvents: [
            "SessionCreated",
            "SessionDeleted",
            "WorldInstalled",
            "WorldRemoved",
          ],
        },
        entry: "./server.mjs",
      },
      {
        "server.mjs": `
          export default function (covel) {
            for (const ev of ["SessionCreated", "SessionDeleted", "WorldInstalled", "WorldRemoved"]) {
              covel.onAppEvent(ev, async (payload, ctx) => {
                // Verify payload is frozen
                let froze = false;
                try {
                  payload.sessionId = "tampered";
                } catch {
                  froze = true;
                }
                const prev = (await ctx.instanceData.get("events", "log")) ?? [];
                await ctx.instanceData.set("events", "log", [...prev, { event: ev, payload, froze }]);
              });
            }
          }
        `,
      },
    );

    const { api: booted, app } = await bootServer();

    // Before granting permissions, creating a world does NOT activate or run community instance plugin
    const resWorldDenied = await app.request("/api/worlds", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: "world-unapproved", name: "Denied World" }),
    });
    expect(resWorldDenied.status).toBe(201);
    await vi.waitFor(async () => {
      const log = await store.getInstanceData(
        "event-observer",
        "events",
        "log",
      );
      expect(log).toBeNull();
    });

    // Grant instance scope + community code
    await grantPlugin(booted, "event-observer", {
      "plugin.communityCode": "allow",
      "plugin.instanceScope": "allow",
    });

    // Now create world, create session, delete session, delete world
    const resWorld = await app.request("/api/worlds", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: "world-approved", name: "Approved World" }),
    });
    expect(resWorld.status).toBe(201);

    const resSession = await app.request("/api/sessions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ worldId: "world-approved" }),
    });
    expect(resSession.status).toBe(201);
    const createdSession = (await resSession.json()) as { id: string };

    const delSess = await app.request(`/api/sessions/${createdSession.id}`, {
      method: "DELETE",
    });
    expect(delSess.status).toBe(200);

    const delWorld = await app.request("/api/worlds/world-approved", {
      method: "DELETE",
    });
    expect(delWorld.status).toBe(200);

    await vi.waitFor(async () => {
      const record = await store.getInstanceData(
        "event-observer",
        "events",
        "log",
      );
      const log = record?.value as
        | Array<{
            event: string;
            payload: Record<string, unknown>;
            froze: boolean;
          }>
        | undefined;
      expect(log?.map((e) => e.event)).toEqual([
        "WorldInstalled",
        "SessionCreated",
        "SessionDeleted",
        "WorldRemoved",
      ]);
      expect(log?.every((e) => e.froze)).toBe(true);
    });

    // Verify GET /:pluginId/instance-data/:namespace returns recorded events
    const instDataRes = await booted.app.request(
      "/api/plugins/event-observer/instance-data/events",
    );
    expect(instDataRes.status).toBe(200);
    const instDataBody = (await instDataRes.json()) as {
      ok: boolean;
      entries: Array<{ key: string; value: unknown }>;
    };
    expect(instDataBody.ok).toBe(true);
    expect(instDataBody.entries.some((e) => e.key === "log")).toBe(true);

    // Direct dispatcher error isolation check
    await writePluginDir(
      builtinDir,
      "builtin-throwing-ev",
      {
        apiVersion: 2,
        scope: "instance",
        contributes: { appEvents: ["AppStarted"] },
      },
      {},
    );
    await writePluginDir(
      builtinDir,
      "builtin-healthy-ev",
      {
        apiVersion: 2,
        scope: "instance",
        contributes: { appEvents: ["AppStarted"] },
      },
      {},
    );
    const { api: isolatedBoot } = await bootServer();
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const isolatedDispatcher = createAppEventDispatcher({
      registry: isolatedBoot.registry,
      store,
      getPermissionService: () => isolatedBoot.permissionService,
      getTrustedSources: () => isolatedBoot.trustedSources,
    });
    const order: string[] = [];
    isolatedDispatcher.register("builtin-throwing-ev", "AppStarted", () => {
      throw new Error("boom");
    });
    isolatedDispatcher.register("builtin-healthy-ev", "AppStarted", () => {
      order.push("healthy");
    });
    await isolatedDispatcher.emit("AppStarted", {
      hostId: "h",
      startedAt: new Date().toISOString(),
    });
    expect(order).toEqual(["healthy"]);
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it("enforces AppScheduler single-flight overlap skip, exponential backoff, scheduleOnce, and clean close()", async () => {
    await writePluginDir(
      builtinDir,
      "builtin-sched-ok",
      {
        apiVersion: 2,
        scope: "instance",
        permissions: { scheduler: true },
        contributes: {
          schedules: [{ id: "tick", intervalMs: 60_000, runOnStart: true }],
        },
      },
      {},
    );
    await writePluginDir(
      builtinDir,
      "builtin-sched-fail",
      {
        apiVersion: 2,
        scope: "instance",
        permissions: { scheduler: true },
        contributes: {
          schedules: [{ id: "flaky", intervalMs: 60_000, runOnStart: false }],
        },
      },
      {},
    );
    const { api: booted } = await bootServer();
    const scheduler = createAppScheduler(
      {
        registry: booted.registry,
        store,
        getPermissionService: () => booted.permissionService,
        getTrustedSources: () => booted.trustedSources,
      },
      { minIntervalMs: 15, maxBackoffMs: 120, defaultTimeoutMs: 500 },
    );

    try {
      let releaseFlight!: () => void;
      const inFlightStarted = new Promise<void>((resolve) => {
        let count = 0;
        scheduler.register("builtin-sched-ok", "tick", async () => {
          count += 1;
          if (count === 1) {
            resolve();
            await new Promise<void>((r) => {
              releaseFlight = r;
            });
          }
        });
      });

      const firstRun = scheduler.runTaskNow("builtin-sched-ok", "tick");
      await inFlightStarted;
      const overlap = await scheduler.runTaskNow("builtin-sched-ok", "tick");
      expect(overlap).toEqual({ status: "skipped-overlap" });
      releaseFlight();
      expect(await firstRun).toEqual({ status: "ran" });

      // Failure tracking & exponential backoff increment then reset
      let shouldFail = true;
      scheduler.register("builtin-sched-fail", "flaky", () => {
        if (shouldFail) throw new Error("transient failure");
      });
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      expect(await scheduler.runTaskNow("builtin-sched-fail", "flaky")).toEqual(
        {
          status: "failed",
        },
      );
      expect(
        scheduler.list().find((t) => t.pluginId === "builtin-sched-fail")
          ?.failureCount,
      ).toBe(1);

      shouldFail = false;
      let onceRan = false;
      scheduler.register("builtin-sched-ok", "once-job", () => {
        onceRan = true;
      });
      await scheduler.scheduleOnce("builtin-sched-ok", "once-job", 5);
      await vi.waitFor(() => {
        expect(onceRan).toBe(true);
      });

      expect(await scheduler.runTaskNow("builtin-sched-fail", "flaky")).toEqual(
        {
          status: "ran",
        },
      );
      expect(
        scheduler.list().find((t) => t.pluginId === "builtin-sched-fail")
          ?.failureCount,
      ).toBe(0);
      expect(scheduler.stats().skippedOverlap).toBe(1);

      const blocked = Promise.withResolvers<void>();
      scheduler.register("builtin-sched-ok", "slow", () => blocked.promise);
      try {
        expect(await scheduler.runTaskNow("builtin-sched-ok", "slow")).toEqual({
          status: "failed",
        });
        expect(await scheduler.runTaskNow("builtin-sched-ok", "tick")).toEqual({
          status: "skipped-overlap",
        });
      } finally {
        blocked.resolve();
      }
      await expect(
        scheduler.runTaskNow("builtin-sched-ok", "tick"),
      ).resolves.toEqual({
        status: "ran",
      });
      warnSpy.mockRestore();
    } finally {
      await scheduler.close();
    }
  });

  it("gates settingsSection, appPage, topbarStatus, dual window, and appCommands via isInstancePluginAllowed", async () => {
    await writePluginDir(
      userDir,
      "ui-platform-probe",
      {
        apiVersion: 2,
        scope: "both",
        contributes: {
          appActions: ["check-status"],
          commands: [
            {
              name: "app-cmd",
              description: "App palette cmd",
              scope: "instance",
              palette: true,
              appAction: "check-status",
            },
          ],
          ui: {
            settingsSection: ["./ui/settings.json"],
            appPage: ["./ui/page.json"],
            topbarStatus: ["./ui/status.json"],
            window: ["./ui/inst-win.json", "./ui/sess-win.json"],
          },
        },
        entry: "./server.mjs",
      },
      {
        "server.mjs": `export default function (covel) { covel.registerAppAction("check-status", () => ({ tone: "ok" })); }`,
        "ui/settings.json": JSON.stringify({
          id: "general-sec",
          label: "Probe Section",
          sectionGroup: "plugins",
          view: { component: "Stack", children: [] },
        }),
        "ui/page.json": JSON.stringify({
          id: "main-page",
          label: "Probe Page",
          view: { component: "Stack", children: [] },
        }),
        "ui/status.json": JSON.stringify({
          id: "badge",
          label: "Probe",
          statusAction: "check-status",
        }),
        "ui/inst-win.json": JSON.stringify({
          id: "win-inst",
          label: "Inst Win",
          windowScope: "instance",
          view: { component: "Stack", children: [] },
        }),
        "ui/sess-win.json": JSON.stringify({
          id: "win-sess",
          label: "Sess Win",
          windowScope: "session",
          view: { component: "Stack", children: [] },
        }),
      },
    );

    const { api: booted, app } = await bootServer();
    await store.createSession({
      id: "sess-ui",
      worldId: "missing",
      status: "active",
      phase: "playing",
      setupRuntimes: {},
      seats: [
        { id: "m", controller: "human", role: "player", characters: "auto" },
      ],
      completedPlayerTurns: 0,
      locale: "en-US",
      activePlugins: ["ui-platform-probe"],
      metadata: {
        approvalScopeNonce: "a",
        sessionIncarnationNonce: "b",
      },
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    // Unapproved community plugin: ALL instance slots + appCommands + instance window must be hidden, while session window stays visible in ?sessionId
    const deniedRes = await (
      await app.request("/api/ui-specs?sessionId=sess-ui")
    ).json();
    expect(deniedRes.settingsSection).toEqual([]);
    expect(deniedRes.appPage).toEqual([]);
    expect(deniedRes.topbarStatus).toEqual([]);
    expect(deniedRes.appCommands).toEqual([]);
    expect(
      deniedRes.window.flatMap((e: { specs: Array<{ id: string }> }) =>
        e.specs.map((s) => s.id),
      ),
    ).toEqual(["win-sess"]);

    // Approve community code + instanceScope
    await grantPlugin(booted, "ui-platform-probe", {
      "plugin.communityCode": "allow",
      "plugin.instanceScope": "allow",
    });

    const allowedRes = await (
      await app.request("/api/ui-specs?sessionId=sess-ui")
    ).json();
    expect(
      allowedRes.settingsSection.map((e: { pluginId: string }) => e.pluginId),
    ).toEqual(["ui-platform-probe"]);
    expect(
      allowedRes.appPage.map((e: { pluginId: string }) => e.pluginId),
    ).toEqual(["ui-platform-probe"]);
    expect(
      allowedRes.topbarStatus.map((e: { pluginId: string }) => e.pluginId),
    ).toEqual(["ui-platform-probe"]);
    expect(allowedRes.appCommands.map((c: { id: string }) => c.id)).toEqual([
      "ui-platform-probe:app-cmd",
    ]);
    expect(
      allowedRes.window.flatMap((e: { specs: Array<{ id: string }> }) =>
        e.specs.map((s) => s.id),
      ),
    ).toEqual(["win-inst", "win-sess"]);

    // L1 hosted ceiling disables plugin.instanceScope fail-closed
    const hostedProfile = deriveHostProfile(
      { ...readRuntimeEnv(), HOST_PROFILE: "demo" } as never,
      { storeBackend: "sqlite" },
    );
    const { api: hostedBooted } = await bootServer(hostedProfile);
    const hostedProj = await buildUiSpecsResponse({
      registry: hostedBooted.registry,
      store,
      permissionService: hostedBooted.permissionService,
      trustedSources: hostedBooted.trustedSources,
    });
    expect(hostedProj.settingsSection).toEqual([]);
    expect(hostedProj.topbarStatus).toEqual([]);
    expect(hostedProj.appCommands).toEqual([]);
  });
});
