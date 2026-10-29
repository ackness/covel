import {
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createPluginRegistry } from "@covel/plugin-loader";
import { createMemoryStore } from "@covel/store/memory";
import { createServerSettings } from "../../src/lib/server-settings.js";
import { createTrustedSourceService } from "../../src/trust/trusted-source-service.js";
import * as files from "../../src/routes/api/install/package-files.js";
import { id, packageFixture } from "./fixtures.js";
vi.mock("node:fs/promises", async (original) => {
  const actual = await original<typeof import("node:fs/promises")>();
  return { ...actual, rename: vi.fn(actual.rename) };
});
let root: string;
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "covel-source-trust-"));
  vi.stubEnv("COVEL_TRUSTED_SOURCES", "");
});
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await rm(root, { recursive: true, force: true });
});
async function build(options: Parameters<typeof packageFixture>[1] = {}) {
  const fixture = await packageFixture(root, options);
  const store = createMemoryStore();
  const settings = createServerSettings(store, { playerWritable: true });
  await settings.load();
  await settings.write({ "trust.sources": ["example/plugins"] });
  const registry = createPluginRegistry();
  registry.register(fixture.entry);
  const trust = createTrustedSourceService({
    settings,
    registry,
    pluginsRoot: root,
  });
  await trust.verifyAll();
  return { ...fixture, settings, registry, trust };
}
it("requires every condition, reads policy live, and rejects builtin/unknown plugins", async () => {
  const { trust, settings, registry, entry } = await build();
  expect(trust.implicitGrant({ pluginId: id })).toBe(true);
  expect(trust.summary(id)).toMatchObject({
    trustedSource: true,
    integrity: "verified",
    autoApproved: true,
  });
  expect(trust.implicitGrant({ pluginId: "unknown" })).toBe(false);
  await settings.write({ "trust.sources": [] });
  expect(trust.implicitGrant({ pluginId: id })).toBe(false);
  await settings.write({ "trust.sources": ["example-evil"] });
  expect(trust.implicitGrant({ pluginId: id })).toBe(false);
  registry.register({ ...entry, source: "builtin" });
  await trust.ensureFresh(id);
  expect(trust.implicitGrant({ pluginId: id })).toBe(false);
});
it.each(["no-snapshot", "no-receipt", "modified", "unreadable"])(
  "fails closed for %s",
  async (condition) => {
    const fixture = await build({
      snapshot: condition === "no-snapshot" ? null : undefined,
    });
    if (condition === "no-receipt") await rm(fixture.receiptPath);
    if (condition === "modified")
      await writeFile(path.join(fixture.directory, "extra.js"), "changed");
    if (condition === "unreadable") await writeFile(fixture.receiptPath, "{");
    await fixture.trust.ensureFresh(id);
    expect(fixture.trust.implicitGrant({ pluginId: id })).toBe(false);
  },
);
it("invalidates on registration and caches digests only while all stat metadata is unchanged", async () => {
  const { trust, registry, entry } = await build();
  const scan = vi.spyOn(files, "checkPackageIntegrity");
  await trust.ensureFresh(id);
  await trust.ensureFresh(id);
  expect(scan).not.toHaveBeenCalled();
  registry.register(entry);
  expect(trust.implicitGrant({ pluginId: id })).toBe(false);
  await trust.ensureFresh(id);
  expect(scan).toHaveBeenCalledOnce();
  expect(trust.implicitGrant({ pluginId: id })).toBe(true);
});
it.each([
  "serverCode",
  "http",
  "hooks",
  "tools",
  "actions",
  "services",
  "wires",
  "forms",
  "extensions",
  "datasets",
] as const)("rejects growth of %s and accepts shrinkage", async (dimension) => {
  const fixture = await build({
    manifest: {
      entry: "./server.js",
      permissions: {
        http: [{ origin: "https://api.test", methods: ["GET", "POST"] }],
      },
      contributes: {
        hooks: [{ event: "PreToolUse", enforce: "pre" }],
        tools: ["tool"],
        actions: ["action"],
        services: ["service@1"],
        wires: ["wire"],
        forms: ["form"],
        extensions: ["prompt.segment@1/probe"],
        datasets: {
          notes: { schema: "notes.schema.json", ops: ["set", "delete"] },
        },
      },
    },
    files: { "server.js": "export default function register() {}" },
  });
  const receipt = await files.readReceipt(fixture.directory);
  const smaller = {
    ...fixture.capabilities,
    [dimension]: dimension === "serverCode" ? false : [],
  };
  await writeFile(
    fixture.receiptPath,
    JSON.stringify({ ...receipt, capabilities: smaller }),
  );
  await fixture.trust.ensureFresh(id);
  expect(fixture.trust.implicitGrant({ pluginId: id })).toBe(false);
  await writeFile(
    fixture.receiptPath,
    JSON.stringify({ ...receipt, capabilities: fixture.capabilities }),
  );
  fixture.registry.register({
    ...fixture.entry,
    packageManifest: {
      ...fixture.entry.packageManifest!,
      plugin: {
        ...fixture.entry.packageManifest!.plugin,
        contributes: {},
        permissions: undefined,
      },
    },
  });
  await fixture.trust.ensureFresh(id);
  expect(fixture.trust.implicitGrant({ pluginId: id })).toBe(true);
});
it("records only a trusted, verified community snapshot with atomic replacement and no other field changes", async () => {
  const fixture = await build({ snapshot: null });
  const before = await files.readReceipt(fixture.directory);
  await fixture.trust.recordSnapshot(id);
  expect(await files.readReceipt(fixture.directory)).toEqual({
    ...before,
    capabilities: fixture.capabilities,
  });
  expect(
    (await readdir(fixture.directory)).filter((name) => name.endsWith(".tmp")),
  ).toEqual([]);
  expect(fixture.trust.implicitGrant({ pluginId: id })).toBe(true);
  await fixture.settings.write({ "trust.sources": [] });
  const text = await readFile(fixture.receiptPath, "utf8");
  await fixture.trust.recordSnapshot(id);
  expect(await readFile(fixture.receiptPath, "utf8")).toBe(text);
  await fixture.settings.write({ "trust.sources": ["example"] });
  await writeFile(path.join(fixture.directory, "edited.txt"), "changed");
  await fixture.trust.recordSnapshot(id);
  expect(await readFile(fixture.receiptPath, "utf8")).toBe(text);
});
it("verification logs a broken package and continues", async () => {
  const fixture = await build();
  const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  await rm(fixture.directory, { recursive: true });
  await expect(fixture.trust.verifyAll()).resolves.toBeUndefined();
  expect(fixture.trust.summary(id).integrity).toBe("unreadable");
  expect(warn).toHaveBeenCalled();
});

it("leaves the original receipt intact and cleans temporary files if atomic promotion fails", async () => {
  const fixture = await build({ snapshot: null });
  const original = await readFile(fixture.receiptPath, "utf8");
  vi.mocked(rename).mockRejectedValueOnce(new Error("rename refused"));
  await expect(fixture.trust.recordSnapshot(id)).rejects.toThrow(
    "rename refused",
  );
  expect(await readFile(fixture.receiptPath, "utf8")).toBe(original);
  expect(
    (await readdir(fixture.directory)).filter((name) => name.endsWith(".tmp")),
  ).toEqual([]);
  expect(fixture.trust.implicitGrant({ pluginId: id })).toBe(false);
});
it.each(["method", "phase", "operation"])(
  "rejects growth within a nested %s declaration",
  async (dimension) => {
    const fixture = await build({
      manifest: {
        entry: "./server.js",
        permissions: {
          http: [{ origin: "https://api.test", methods: ["GET", "POST"] }],
        },
        contributes: {
          hooks: [{ event: "PreToolUse", enforce: "pre" }],
          datasets: {
            notes: { schema: "notes.schema.json", ops: ["set", "delete"] },
          },
        },
      },
      files: { "server.js": "export default function register() {}" },
    });
    const receipt = await files.readReceipt(fixture.directory);
    const snapshot = { ...fixture.capabilities };
    if (dimension === "method")
      snapshot.http = [{ origin: "https://api.test", methods: ["GET"] }];
    if (dimension === "phase")
      snapshot.hooks = [{ event: "PreToolUse", enforce: "normal" }];
    if (dimension === "operation")
      snapshot.datasets = [{ namespace: "notes", ops: ["set"] }];
    await writeFile(
      fixture.receiptPath,
      JSON.stringify({ ...receipt, capabilities: snapshot }),
    );
    await fixture.trust.ensureFresh(id);
    expect(fixture.trust.implicitGrant({ pluginId: id })).toBe(false);
  },
);

it("ignores stored policy on shared forms and uses only the operator environment", async () => {
  const fixture = await build();
  const shared = createTrustedSourceService({
    settings: { ...fixture.settings, playerWritable: false },
    registry: fixture.registry,
    pluginsRoot: root,
  });
  await shared.verifyAll();
  expect(shared.policy()).toEqual([]);
  expect(shared.implicitGrant({ pluginId: id })).toBe(false);
  vi.stubEnv("COVEL_TRUSTED_SOURCES", "EXAMPLE/plugins");
  expect(shared.policy()).toEqual(["example/plugins"]);
  expect(shared.implicitGrant({ pluginId: id })).toBe(true);
});
it("logs and ignores an invalid environment policy as a whole", async () => {
  const fixture = await build();
  vi.stubEnv("COVEL_TRUSTED_SOURCES", "another,invalid/");
  const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  const trust = createTrustedSourceService({
    settings: fixture.settings,
    registry: fixture.registry,
    pluginsRoot: root,
  });
  expect(warn).toHaveBeenCalledWith(
    expect.stringContaining("Invalid COVEL_TRUSTED_SOURCES"),
  );
  expect(trust.policy()).toEqual(["example/plugins"]);
});
