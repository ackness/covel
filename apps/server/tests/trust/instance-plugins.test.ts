import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readRuntimeEnv } from "@covel/shared";
import { createMemoryStore } from "@covel/store/memory";
import { deriveHostProfile, type HostProfile } from "../../src/host-profile.js";
import {
  bootstrapApi,
  type ApiBootstrapResult,
} from "../../src/routes/api/bootstrap.js";
import { closeTestApi } from "../helpers/close-api.js";

const md = (frontmatter: Record<string, unknown>) =>
  `---\n${JSON.stringify(frontmatter)}\n---\nInstance plugin fixture`;

async function writePluginDir(
  parentDir: string,
  pluginId: string,
  manifest: Record<string, unknown>,
  files: Record<string, string> = {},
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

describe("instance plugins & dual-axis apiVersion", () => {
  let root: string;
  let builtinDir: string;
  let userDir: string;
  let covelHome: string;
  let store: ReturnType<typeof createMemoryStore>;
  let api: ApiBootstrapResult | undefined;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "covel-instance-plugins-"));
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

  it("enforces dual-axis apiVersion checks while preserving discovery of compatible plugins", async () => {
    await writePluginDir(userDir, "bad-api-ver", {
      apiVersion: 99,
      scope: "instance",
      activationEvents: ["onStartup"],
    });
    await writePluginDir(userDir, "good-api-ver", {
      apiVersion: 2,
      scope: "instance",
      activationEvents: ["onStartup"],
    });

    const booted = await bootServer();
    expect(booted.registry.get("bad-api-ver")).toMatchObject({
      status: "error",
      error: expect.stringContaining("apiVersion 99"),
    });
    expect(
      booted.registry.get("good-api-ver")?.packageManifest?.plugin.apiVersion,
    ).toBe(2);
    expect(
      booted.instancePlugins.listInstancePlugins().map((item) => item.pluginId),
    ).toEqual(["good-api-ver"]);
  });

  it("defers onAppAction:* lazily and activates onStartup only with persisted L3 grants", async () => {
    const startupPluginDir = await writePluginDir(
      userDir,
      "startup-inst",
      {
        apiVersion: 2,
        scope: "instance",
        activationEvents: ["onStartup"],
        entry: "./server.mjs",
      },
      {
        "server.mjs": `
          export default async function (covel) {
            await covel.instanceData.set("boot", "ran", true);
          }
        `,
      },
    );
    const lazyPluginDir = await writePluginDir(
      userDir,
      "lazy-action-inst",
      {
        apiVersion: 2,
        scope: "instance",
        activationEvents: ["onAppAction:demo"],
        entry: "./server.mjs",
      },
      {
        "server.mjs": `
          export default async function (covel) {
            await covel.instanceData.set("lazy", "ran", "activated");
          }
        `,
      },
    );
    expect(startupPluginDir).toBeTruthy();
    expect(lazyPluginDir).toBeTruthy();

    // First boot: neither plugin has L3 grants, so neither activates at startup.
    let booted = await bootServer();
    expect(booted.instancePlugins.isActivated("startup-inst")).toBe(false);
    expect(booted.instancePlugins.isActivated("lazy-action-inst")).toBe(false);
    expect(
      await store.getInstanceData("startup-inst", "boot", "ran"),
    ).toBeNull();
    await expect(
      booted.instancePlugins.activate("startup-inst"),
    ).rejects.toThrow(/not permitted/i);

    // Grant L3 capabilities to both community instance plugins.
    for (const pluginId of ["startup-inst", "lazy-action-inst"]) {
      const summary = await booted.permissionService.inspectPlugin(pluginId);
      await booted.permissionService.setPluginGrant(pluginId, {
        decisions: {
          "plugin.communityCode": "allow",
          "plugin.instanceScope": "allow",
        },
        expectedDigest: summary.contentDigest!,
      });
    }

    // Reboot on the same store: onStartup activates on boot, while onAppAction:demo stays dormant.
    booted = await bootServer();
    expect(booted.instancePlugins.isActivated("startup-inst")).toBe(true);
    expect(booted.instancePlugins.isActivated("lazy-action-inst")).toBe(false);
    expect(
      (await store.getInstanceData("startup-inst", "boot", "ran"))?.value,
    ).toBe(true);
    expect(
      await store.getInstanceData("lazy-action-inst", "lazy", "ran"),
    ).toBeNull();

    // Trigger lazy activation event -> activates only lazy-action-inst cleanly.
    const activated =
      await booted.instancePlugins.activateForEvent("onAppAction:demo");
    expect(activated).toEqual(["lazy-action-inst"]);
    expect(booted.instancePlugins.isActivated("lazy-action-inst")).toBe(true);
    expect(
      (await store.getInstanceData("lazy-action-inst", "lazy", "ran"))?.value,
    ).toBe("activated");
  });

  it("hard-blocks instance activation and high-risk primitives in browser-private and hosted forms", async () => {
    const probeBridgePath = path.join(root, "builtin-probe-bridge.mjs");
    await writeFile(
      probeBridgePath,
      `
        export let capturedApi = undefined;
        export function capture(api) { capturedApi = api; }
      `,
      "utf8",
    );

    // Builtin instance-only plugin and builtin dual-scope plugin.
    await writePluginDir(
      builtinDir,
      "builtin-instance-only",
      {
        apiVersion: 2,
        scope: "instance",
        activationEvents: ["onStartup"],
        permissions: { secrets: true, sandboxWorker: true },
        entry: "./server.mjs",
      },
      {
        "server.mjs": `
          export default async function (covel) {
            await covel.instanceData.set("boot", "shouldNotRun", true);
          }
        `,
      },
    );
    await writePluginDir(
      builtinDir,
      "builtin-both-probe",
      {
        apiVersion: 2,
        scope: "both",
        activationEvents: ["onAppAction:probe"],
        permissions: { secrets: true, sandboxWorker: true },
        entry: "./server.mjs",
      },
      {
        "server.mjs": `
          import { capture } from ${JSON.stringify(pathToFileURL(probeBridgePath).href)};
          export default function (covel) {
            capture(covel);
          }
        `,
      },
    );

    // Community instance plugin with pre-seeded personal L3 grants.
    await writePluginDir(
      userDir,
      "community-inst",
      {
        apiVersion: 2,
        scope: "instance",
        activationEvents: ["onStartup"],
        permissions: { secrets: true, sandboxWorker: true },
        entry: "./server.mjs",
      },
      {
        "server.mjs": `
          export default async function (covel) {
            await covel.instanceData.set("boot", "shouldNotRun", true);
          }
        `,
      },
    );

    // Grant community plugin under personal profile first.
    let booted = await bootServer(
      deriveHostProfile(readRuntimeEnv(), { storeBackend: "sqlite" }),
    );
    const commSummary =
      await booted.permissionService.inspectPlugin("community-inst");
    await booted.permissionService.setPluginGrant("community-inst", {
      decisions: {
        "plugin.communityCode": "allow",
        "plugin.instanceScope": "allow",
        "secrets.own": "allow",
        "compute.sandboxWorker": "allow",
      },
      expectedDigest: commSummary.contentDigest!,
    });

    const restrictedProfiles: HostProfile[] = [
      deriveHostProfile(
        { ...readRuntimeEnv(), nodeEnv: "production" },
        { storeBackend: "memory" },
      ),
      deriveHostProfile(
        { ...readRuntimeEnv(), deploymentTier: "demo" },
        { storeBackend: "sqlite" },
      ),
    ];

    const bridge = (await import(pathToFileURL(probeBridgePath).href)) as {
      capturedApi?: {
        instanceData?: {
          set: (ns: string, k: string, v: string) => Promise<void>;
        };
        secrets?: { set: (k: string, v: string) => Promise<unknown> };
        sandbox?: {
          run: (opts: { code: string; input: unknown }) => Promise<unknown>;
        };
      };
    };

    for (const profile of restrictedProfiles) {
      expect(
        profile.form === "browser-private" || profile.form === "hosted",
      ).toBe(true);
      booted = await bootServer(profile);

      expect(booted.instancePlugins.isActivated("builtin-instance-only")).toBe(
        false,
      );
      expect(booted.instancePlugins.isActivated("community-inst")).toBe(false);
      for (const item of booted.instancePlugins.listInstancePlugins()) {
        expect(item.allowed).toBe(false);
      }

      await expect(
        booted.instancePlugins.activate("builtin-instance-only"),
      ).rejects.toThrow(/not permitted/i);
      await expect(
        booted.instancePlugins.activate("community-inst"),
      ).rejects.toThrow(/not permitted/i);

      // Even a builtin dual-scope plugin loaded for session capabilities cannot call instance primitives.
      expect(bridge.capturedApi).toBeDefined();
      await expect(
        bridge.capturedApi!.instanceData!.set("cfg", "k", "v"),
      ).rejects.toThrow(/plugin\.instanceScope/);
      await expect(
        bridge.capturedApi!.secrets!.set("tok", "secret"),
      ).rejects.toMatchObject({ code: "capability_denied" });
      await expect(
        bridge.capturedApi!.sandbox!.run({ code: "return 1;", input: null }),
      ).rejects.toThrow(/compute\.sandboxWorker/);
    }
  });

  it("runs personal instance plugin with hostId, instanceData, secrets, sandbox and enforces live revocation", async () => {
    const bridgePath = path.join(root, "personal-probe-bridge.mjs");
    await writeFile(
      bridgePath,
      `
        export let capturedApi = undefined;
        export function capture(api) { capturedApi = api; }
      `,
      "utf8",
    );

    await writePluginDir(
      userDir,
      "full-inst-probe",
      {
        apiVersion: 2,
        scope: "instance",
        activationEvents: ["onAppAction:probe"],
        permissions: { secrets: true, sandboxWorker: true },
        entry: "./server.mjs",
      },
      {
        "server.mjs": `
          import { capture } from ${JSON.stringify(pathToFileURL(bridgePath).href)};
          export default async function (covel) {
            capture(covel);
            await covel.instanceData.set("state", "host", {
              hostId: covel.hostId,
              computed: await covel.sandbox.run({
                code: "return input.base * 2;",
                input: { base: 21 },
              }),
            });
            await covel.secrets.set("oauth", { accessToken: "secret-v1" });
          }
        `,
      },
    );

    const booted = await bootServer();
    const summary =
      await booted.permissionService.inspectPlugin("full-inst-probe");
    await booted.permissionService.setPluginGrant("full-inst-probe", {
      decisions: {
        "plugin.communityCode": "allow",
        "plugin.instanceScope": "allow",
        "secrets.own": "allow",
        "compute.sandboxWorker": "allow",
      },
      expectedDigest: summary.contentDigest!,
    });

    const activated =
      await booted.instancePlugins.activateForEvent("onAppAction:probe");
    expect(activated).toEqual(["full-inst-probe"]);

    const stored = await store.getInstanceData(
      "full-inst-probe",
      "state",
      "host",
    );
    expect(stored?.value).toEqual({
      hostId: booted.hostId,
      computed: 42,
    });

    const bridge = (await import(pathToFileURL(bridgePath).href)) as {
      capturedApi: {
        hostId?: string;
        instanceData: {
          get: (ns: string, k: string) => Promise<unknown>;
          list: (ns: string) => Promise<readonly { key: string }[]>;
        };
        secrets: {
          get: (
            k: string,
          ) => Promise<{ value: unknown; generation: number } | null>;
        };
        sandbox: {
          run: (opts: { code: string; input: unknown }) => Promise<unknown>;
        };
      };
    };

    expect(bridge.capturedApi.hostId).toBe(booted.hostId);
    await expect(
      bridge.capturedApi.instanceData.get("_reserved", "x"),
    ).rejects.toThrow(/must not start with "_"/);
    await expect(
      bridge.capturedApi.secrets.get("oauth"),
    ).resolves.toMatchObject({
      value: { accessToken: "secret-v1" },
      generation: 1,
    });
    await expect(
      bridge.capturedApi.sandbox.run({ code: "return input + 1;", input: 9 }),
    ).resolves.toBe(10);

    // Live capability revocation takes effect immediately without restarting the server.
    await booted.permissionService.setPluginGrant("full-inst-probe", {
      decisions: {
        "plugin.communityCode": "allow",
        "plugin.instanceScope": "allow",
        "secrets.own": "deny",
        "compute.sandboxWorker": "deny",
      },
      expectedDigest: summary.contentDigest!,
    });

    await expect(bridge.capturedApi.secrets.get("oauth")).rejects.toMatchObject(
      { code: "capability_denied" },
    );
    await expect(
      bridge.capturedApi.sandbox.run({ code: "return 1;", input: null }),
    ).rejects.toThrow(/compute\.sandboxWorker/);
  });
});
