import { hashSessionOwnerToken } from "../../src/routes/api/session/session-guard.js";
// @vitest-environment node
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  createPluginRegistry,
  type PluginRegistry,
} from "@covel/plugin-loader";
import { resolvedPluginThemeSchema } from "@covel/shared";
import { createMemoryStore } from "@covel/store/memory";
import { createMiscApiRoutes } from "../../src/routes/misc-api.js";
import {
  buildUiSpecsResponse,
  __resetUiSpecsCache,
} from "../../src/routes/misc-api/ui-specs.js";
import { validatePluginBundle } from "../../src/routes/api/install/plugin-bundle.js";
import { registerTestPlugins } from "../helpers/register-test-plugins.js";
const fixture = path.resolve(
  import.meta.dirname,
  "../../../../tests/third-party/theme-pack-probe",
);
const stubAi = {
  presetRegistry: { listPresets: () => [] },
  gateway: {},
} as unknown as Parameters<typeof createMiscApiRoutes>[0];
let root: string;
let registry: PluginRegistry;
let store: ReturnType<typeof createMemoryStore>;
const packagePath = () => path.join(root, "theme-pack-probe");
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "theme-api-"));
  await cp(fixture, packagePath(), { recursive: true });
  registry = createPluginRegistry();
  store = createMemoryStore();
  await registerTestPlugins(registry, [root]);
});
afterEach(async () => {
  vi.unstubAllEnvs();
  __resetUiSpecsCache();
  await rm(root, { recursive: true, force: true });
});
const app = () => createMiscApiRoutes(stubAi, registry, store);
const read = () => buildUiSpecsResponse({ registry, store });
async function session(activePlugins: string[] = []) {
  await store.createSession({
    id: "s",
    status: "active",
    phase: "playing",
    locale: "en-US",
    completedPlayerTurns: 0,
    setupRuntimes: {},
    seats: [
      { id: "main", controller: "human", role: "player", characters: "auto" },
    ],
    activePlugins,
    createdAt: "2026-10-31",
    updatedAt: "2026-10-31",
  });
}
async function entries() {
  const entries: { relativePath: string; content: Buffer }[] = [];
  async function walk(relative: string) {
    for (const item of await readdir(path.join(packagePath(), relative), {
      withFileTypes: true,
    })) {
      const name = relative ? `${relative}/${item.name}` : item.name;
      if (item.isDirectory()) await walk(name);
      else
        entries.push({
          relativePath: name,
          content: await readFile(path.join(packagePath(), name)),
        });
    }
  }
  await walk("");
  return entries;
}
it("publishes required typed themes with host ownership, content hash and compiled CSS", async () => {
  const response = await app().request("/api/ui-specs");
  expect(response.status).toBe(200);
  const body = (await response.json()) as Awaited<ReturnType<typeof read>>;
  expect(body.theme).toHaveLength(1);
  expect(body.theme[0]?.pluginId).toBe("theme-pack-probe");
  const theme = body.theme[0]!.specs[0]!;
  expect(resolvedPluginThemeSchema.safeParse(theme).success).toBe(true);
  expect(theme.pluginId).toBe("theme-pack-probe");
  expect(theme.contentHash).toMatch(/^[a-f0-9]{64}$/);
  expect(theme.cssText).toContain(
    `[data-covel-theme-scope="${theme.contentHash}"]`,
  );
  expect(theme.cssText).toContain(
    `/plugin-assets/theme-pack-probe/${theme.assets!.digest}/paper.png`,
  );
  expect(theme).not.toHaveProperty("css");
  expect(theme.assets).not.toHaveProperty("root");
  expect(JSON.stringify(body)).not.toContain(root);
});
it("filters by the owner's runnable session plugins and always includes theme", async () => {
  await session();
  const response = await app().request("/api/ui-specs?sessionId=s");
  expect(response.status).toBe(200);
  expect((await response.json()).theme).toEqual([]);
  await store.updateSession("s", { activePlugins: ["theme-pack-probe"] });
  const enabled = await app().request("/api/ui-specs?sessionId=s");
  expect((await enabled.json()).theme).toHaveLength(1);
  const unknown = await app().request("/api/ui-specs?sessionId=missing");
  expect(unknown.status).toBe(404);
});
it("isolates a broken theme while retaining another theme and an ordinary view", async () => {
  await writeFile(
    path.join(packagePath(), "PLUGIN.md"),
    "---\ndescription: Reading\ncontributes:\n  ui:\n    theme: [./ui/reading-theme.json, ./ui/good.json]\n    view: [./ui/view.json]\n---\n",
  );
  await writeFile(
    path.join(packagePath(), "ui/good.json"),
    JSON.stringify({
      id: "good",
      label: "Good",
      tokens: { dark: { "--story-color": "#fff" } },
    }),
  );
  await writeFile(
    path.join(packagePath(), "ui/view.json"),
    JSON.stringify({
      id: "ordinary",
      label: "Ordinary",
      view: { component: "Text", props: { content: "Visible" } },
    }),
  );
  await writeFile(
    path.join(packagePath(), "ui/reading-theme.css"),
    ".story{position:fixed}",
  );
  await registerTestPlugins(registry, [root]);
  const body = await read();
  expect(body.theme[0]?.specs.map((theme) => theme.id)).toEqual(["good"]);
  expect(body.view[0]?.specs[0]?.id).toBe("ordinary");
  expect(body.diagnostics).toContainEqual(
    expect.objectContaining({
      slot: "theme",
      declaredPath: "./ui/reading-theme.json",
      issues: [
        expect.objectContaining({ path: "css.rules[0].declarations[0]" }),
      ],
    }),
  );
  expect(JSON.stringify(body.diagnostics)).not.toContain("position:fixed");
});
it("caches registry projections and invalidates identity after re-registration", async () => {
  const first = (await read()).theme[0]!.specs[0]!;
  const bitmap = path.join(packagePath(), "ui/reading-assets/paper.png");
  const bytes = await readFile(bitmap);
  bytes[bytes.length - 1] = bytes[bytes.length - 1]! ^ 1;
  await writeFile(bitmap, bytes);
  expect((await read()).theme[0]!.specs[0]!.contentHash).toBe(
    first.contentHash,
  );
  await registerTestPlugins(registry, [root]);
  const next = (await read()).theme[0]!.specs[0]!;
  expect(next.contentHash).not.toBe(first.contentHash);
  expect(next.assets!.digest).not.toBe(first.assets!.digest);
  const css = path.join(packagePath(), "ui/reading-theme.css");
  await writeFile(css, (await readFile(css, "utf8")).replace("1.8", "1.9"));
  await registerTestPlugins(registry, [root]);
  expect((await read()).theme[0]!.specs[0]!.contentHash).not.toBe(
    next.contentHash,
  );
});
it("returns copies and keeps content identity independent of UI language", async () => {
  const body = await read();
  const first = structuredClone(body.theme[0]!.specs[0]!);
  body.theme[0]!.specs[0]!.label = "Changed by caller";
  body.theme[0]!.specs[0]!.assets!.files.splice(0);
  expect((await read()).theme[0]!.specs[0]).toEqual(first);
  for (const language of ["en-US", "zh-CN"]) {
    const response = await app().request("/api/ui-specs", {
      headers: { "Accept-Language": language },
    });
    expect((await response.json()).theme[0].specs[0].contentHash).toBe(
      first.contentHash,
    );
  }
});
it("never imports a throwing entry or reads private session data during theme discovery", async () => {
  await writeFile(
    path.join(packagePath(), "PLUGIN.md"),
    (await readFile(path.join(packagePath(), "PLUGIN.md"), "utf8")).replace(
      "description:",
      "entry: ./server/index.js\ndescription:",
    ),
  );
  await mkdir(path.join(packagePath(), "server"));
  await writeFile(
    path.join(packagePath(), "server/index.js"),
    'throw new Error("ENTRY_EXECUTED");',
  );
  await registerTestPlugins(registry, [root]);
  await session(["theme-pack-probe"]);
  await store.setPluginData({
    id: "private-theme-row",
    createdAt: "2026-10-31",
    sessionId: "s",
    pluginId: "theme-pack-probe",
    namespace: "_hidden.notes",
    key: "secret",
    value: "PRIVATE_SENTINEL",
    updatedAt: "2026-10-31",
  });
  await store.updateSession("s", {
    metadata: { privateSettings: "PRIVATE_SENTINEL" },
  });
  // The store proxy makes any attempt to read hidden data, traces, native
  // continuations, settings or keys fail rather than returning a vacuous sentinel.
  const privateStore = new Proxy(store, {
    get(target, property, receiver) {
      if (property !== "getSession") throw new Error("PRIVATE_SENTINEL");
      return Reflect.get(target, property, receiver);
    },
  });
  const body = await buildUiSpecsResponse({
    registry,
    store: privateStore,
    sessionId: "s",
  });
  expect(body.theme).toHaveLength(1);
  expect(JSON.stringify(body)).not.toMatch(/PRIVATE_SENTINEL|ENTRY_EXECUTED/);
});
it("runs the real ZIP intake against exact binary assets and localized descriptor bounds", async () => {
  const good = await entries();
  expect(
    validatePluginBundle(good, new Set(), "theme-pack-probe").executionMode,
  ).toBe("declarative");
  const bad = good.map((entry) =>
    entry.relativePath.endsWith("paper.png")
      ? { ...entry, content: Buffer.from("<svg/>") }
      : entry,
  );
  expect(() =>
    validatePluginBundle(bad, new Set(), "theme-pack-probe"),
  ).toThrow("bitmap");
  const translated = good.map((entry) =>
    entry.relativePath === "locales/zh.yaml"
      ? {
          ...entry,
          content: Buffer.from(
            `messages:\n  Reading room: ${"字".repeat(81)}\n`,
          ),
        }
      : entry,
  );
  expect(() =>
    validatePluginBundle(translated, new Set(), "theme-pack-probe"),
  ).toThrow("theme");
  const script = [
    ...good,
    {
      relativePath: "ui/reading-assets/script.js",
      content: Buffer.from("throw new Error('server')"),
    },
  ];
  expect(
    validatePluginBundle(script, new Set(), "theme-pack-probe").executionMode,
  ).toBe("code");
});

it("requires the session owner before returning active theme metadata", async () => {
  vi.stubEnv("DEPLOYMENT_TIER", "demo");
  vi.stubEnv("COVEL_DESKTOP_REST_TOKEN", "operator");
  await session(["theme-pack-probe"]);
  await store.updateSession("s", {
    metadata: { ownerTokenHash: hashSessionOwnerToken("owner-secret") },
  });
  const denied = await app().request("/api/ui-specs?sessionId=s");
  expect(denied.status).toBe(401);
  expect((await denied.json()).code).toBe("session_owner_required");
  const allowed = await app().request("/api/ui-specs?sessionId=s", {
    headers: {
      "X-Session-Token": "owner-secret",
      "X-Provider-Keys": '{"provider":"KEY_SECRET_SENTINEL"}',
    },
  });
  expect(allowed.status).toBe(200);
  const body = await allowed.json();
  expect(body.theme).toHaveLength(1);
  expect(JSON.stringify(body)).not.toMatch(/owner-secret|KEY_SECRET_SENTINEL/);
});
