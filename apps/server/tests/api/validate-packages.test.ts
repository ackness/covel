// @vitest-environment node
import {
  access,
  mkdir,
  mkdtemp,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import yazl from "yazl";
import { packageValidationReportSchema } from "@covel/shared";
import {
  createPluginRegistry,
  discoverPluginAt,
  loadPluginDefinition,
  loadPluginSummary,
  validatePluginPackage,
} from "@covel/plugin-loader";
import { installRoutes } from "../../src/routes/api/install.js";
import { validatePluginBundle } from "../../src/routes/api/install/plugin-bundle.js";
import { validationReport } from "../../src/routes/api/install/validate.js";
import { validateWorldPackage } from "../../src/world-data/validate-world-package.js";
import { createRequestBodyLimitMiddleware } from "../../src/middleware/request-body-limit.js";
import { deriveHostProfile } from "../../src/host-profile.js";
import { readRuntimeEnv } from "@covel/shared";
import * as serialQueue from "../../src/lib/serial-queue.js";
import { runSerial } from "../../src/lib/serial-queue.js";

let root: string;
let app: Hono;
let registry: ReturnType<typeof createPluginRegistry>;
const manifest = (extra: Record<string, unknown> = {}) =>
  `---\n${JSON.stringify({ id: "probe", description: "Probe", ...extra })}\n---\n`;
const world =
  "id: sample\nname: Sample\nsummary: Sample world\ndefaultLocale: en-US\n";
async function files(dir: string, entries: Record<string, string>) {
  for (const [file, text] of Object.entries(entries)) {
    await mkdir(path.dirname(path.join(dir, file)), { recursive: true });
    await writeFile(path.join(dir, file), text);
  }
}
async function plugin(extra: Record<string, unknown> = {}, register = false) {
  const dir = path.join(root, "plugins/probe");
  await files(dir, { "PLUGIN.md": manifest(extra) });
  if (register) {
    const discovery = await discoverPluginAt(dir);
    if (!discovery) throw new Error("Missing fixture");
    const definition = await loadPluginDefinition(discovery);
    registry.register({
      id: "probe",
      rootPath: dir,
      ...definition,
      summary: await loadPluginSummary(discovery, undefined, definition),
      loadedRuntimes: new Map(),
      status: "registered",
    });
  }
  return dir;
}
function post(kind: "plugin" | "world", source: unknown) {
  return app.request(`/api/install/validate/${kind}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ source }),
  });
}
async function zip(entries: Record<string, string>) {
  const archive = new yazl.ZipFile();
  for (const [name, text] of Object.entries(entries))
    archive.addBuffer(Buffer.from(text), name);
  const chunks: Buffer[] = [];
  const result = new Promise<Buffer>((resolve, reject) => {
    archive.outputStream.on("data", (chunk: Buffer) => chunks.push(chunk));
    archive.outputStream.on("end", () => resolve(Buffer.concat(chunks)));
    archive.outputStream.on("error", reject);
  });
  archive.end();
  return result;
}
function upload(
  kind: "plugin" | "world",
  buffer: Buffer,
  fileName = "input.zip",
) {
  const body = new FormData();
  body.append(
    "file",
    new Blob([new Uint8Array(buffer)], { type: "text/plain" }),
    fileName,
  );
  return app.request(`/api/install/validate/${kind}`, { method: "POST", body });
}
beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "validation-api-"));
  vi.stubEnv("COVEL_HOME", root);
  vi.stubEnv("COVEL_USER_PLUGINS_DIR", path.join(root, "plugins"));
  vi.stubEnv("COVEL_USER_WORLDS_DIR", path.join(root, "worlds"));
  vi.stubEnv("DEPLOYMENT_TIER", "self");
  vi.stubEnv("COVEL_DESKTOP_REST_TOKEN", "");
  vi.stubEnv("COVEL_INSTALL_API_ENABLED", "1");
  registry = createPluginRegistry();
  app = new Hono();
  app.use("*", createRequestBodyLimitMiddleware());
  app.use("*", async (c, next) => {
    c.set("pluginRegistry", registry);
    c.set("worldsDirs", [
      path.join(root, "worlds"),
      path.join(root, "other-worlds"),
    ]);
    await next();
  });
  app.route("/api/install", installRoutes);
});
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await rm(root, { recursive: true, force: true });
});

describe("package validation endpoints", () => {
  it.each([true, false])(
    "validates registered=%s installed plugin and matches the static core",
    async (registered) => {
      const dir = await plugin({}, registered);
      const response = await post("plugin", { kind: "installed", id: "probe" });
      expect(response.status).toBe(200);
      const result = packageValidationReportSchema.parse(await response.json());
      const core = await validatePluginPackage(dir);
      expect(result).toEqual(
        validationReport("plugin", dir, core.issues, "probe", {
          version: core.version,
          languages: core.languages,
        }),
      );
    },
  );
  it("reports several independent failures with HTTP 200 and no host paths", async () => {
    const dir = await plugin({
      future: true,
      runtime: {
        function: { handler: "./missing.js" },
        schedule: { trigger: { type: "manual" } },
      },
    });
    await files(dir, {
      "package.json": '{"type":"commonjs"}',
      "locales/zh.yaml": "PLUGIN.md:\n  kind: 插件\n",
    });
    const response = await post("plugin", { kind: "installed", id: "probe" });
    expect(response.status).toBe(200);
    const text = await response.text();
    const result = packageValidationReportSchema.parse(JSON.parse(text));
    expect(result.ok).toBe(false);
    expect(result.issues.map((issue) => issue.code)).toEqual(
      expect.arrayContaining([
        "unknown-field",
        "plugin-files",
        "locale-files",
        "package-module-type",
      ]),
    );
    for (const prefix of [
      root,
      os.tmpdir(),
      os.homedir(),
      path.join(root, "plugins"),
    ])
      expect(text).not.toContain(prefix);
    expect(text).not.toContain("cliFailure");
    expect(text).not.toContain("cliWarnings");
  });
  it.each([false, true])(
    "unwraps plugin ZIP, cleans up, and reports invalid=%s",
    async (invalid) => {
      const before = new Set(await readdir(os.tmpdir()));
      const response = await upload(
        "plugin",
        await zip({
          "outer/PLUGIN.md": manifest(invalid ? { future: true } : {}),
        }),
      );
      const report = packageValidationReportSchema.parse(await response.json());
      expect(report.ok, JSON.stringify(report)).toBe(!invalid);
      expect(
        (await readdir(os.tmpdir())).filter(
          (name) => name.startsWith("covel-validate-") && !before.has(name),
        ),
      ).toEqual([]);
    },
  );
  it.each([
    { directory: undefined, packageName: "@fixture/plugin-probe" },
    { directory: "probe", packageName: "@fixture/plugin-other" },
    { directory: "Invalid Folder", packageName: "@fixture/plugin-probe" },
  ])(
    "preserves omitted plugin IDs and runtime dependencies for $directory",
    async ({ directory, packageName }) => {
      const runtime = (needs: string[] = []) =>
        `---\n${JSON.stringify({ function: { handler: "./handler.js" }, schedule: { trigger: { type: "manual" }, ...(needs.length ? { needs } : {}) } })}\n---\n`;
      const entries = {
        "PLUGIN.md": manifest({ id: undefined }),
        "package.json": JSON.stringify({ name: packageName, type: "module" }),
        "runtimes/extract/RUNTIME.md": runtime(),
        "runtimes/extract/handler.js": "throw new Error('must never run');",
        "runtimes/read/RUNTIME.md": runtime(["probe/extract"]),
        "runtimes/read/handler.js": "throw new Error('must never run');",
      };
      const installed = validatePluginBundle(
        Object.entries(entries).map(([relativePath, content]) => ({
          relativePath,
          content: Buffer.from(content),
        })),
        new Set(),
        directory,
      );
      expect(installed.pluginId).toBe("probe");
      const response = await upload(
        "plugin",
        await zip(
          Object.fromEntries(
            Object.entries(entries).map(([file, content]) => [
              directory ? `${directory}/${file}` : file,
              content,
            ]),
          ),
        ),
      );
      expect(response.status).toBe(200);
      const report = packageValidationReportSchema.parse(await response.json());
      expect(report.id).toBe(installed.pluginId);
      expect(report.ok, JSON.stringify(report.issues)).toBe(true);
      expect(report.counts.errors).toBe(0);
      await expect(access(path.join(root, "plugins/probe"))).rejects.toThrow();
    },
  );
  it.each([
    {
      directory: undefined,
      fileName: "sample.zip",
      id: undefined,
      expected: "sample",
    },
    {
      directory: "wrapped-world",
      fileName: "different.zip",
      id: undefined,
      expected: "wrapped-world",
    },
    {
      directory: "wrapped-world",
      fileName: "different.zip",
      id: "explicit-world",
      expected: "explicit-world",
    },
  ])(
    "preserves world ZIP identity $expected",
    async ({ directory, fileName, id, expected }) => {
      const entries = {
        "world.yaml": world.replace("id: sample\n", id ? `id: ${id}\n` : ""),
        "WORLD.md": "Lore",
      };
      const response = await upload(
        "world",
        await zip(
          Object.fromEntries(
            Object.entries(entries).map(([file, content]) => [
              directory ? `${directory}/${file}` : file,
              content,
            ]),
          ),
        ),
        fileName,
      );
      expect(response.status).toBe(200);
      const report = packageValidationReportSchema.parse(await response.json());
      expect(report).toMatchObject({
        id: expected,
        ok: true,
        counts: { errors: 0, warnings: 0 },
        issues: [],
      });
    },
  );
  it("validates installed worlds using the injected catalogue", async () => {
    await plugin(
      {
        provides: ["probe-state@1"],
        contributes: {
          settings: [
            { key: "enabled", type: "toggle", default: true, label: "Enabled" },
          ],
        },
      },
      true,
    );
    const dir = path.join(root, "worlds/sample");
    const hostPath = path.join(
      os.homedir(),
      "private/validation-secret/cover.png",
    );
    await files(dir, {
      "world.yaml": `${world}cover: ${JSON.stringify(hostPath)}\npluginPolicy:\n  plus: [probe]\n  requires: [probe-state@1]\npluginSettings:\n  probe:\n    enabled: wrong\n    ${JSON.stringify(hostPath)}: true\n`,
      "WORLD.md": "<!-- narrator-only -->\nUnclosed lore.",
    });
    const response = await post("world", { kind: "installed", id: "sample" });
    expect(response.status).toBe(200);
    const text = await response.text();
    const report = packageValidationReportSchema.parse(JSON.parse(text));
    const core = await validateWorldPackage({
      worldDir: dir,
      catalogue: registry,
    });
    const loreMessage =
      "this narrator-only block has no closing line; the player sees nothing from here to the end of the file";
    const loreHint =
      "Put `<!-- narrator-only -->` on a line of its own before the part, and `<!-- /narrator-only -->` on a line of its own after it.";
    const coverHint =
      "Name an existing `.png`, `.jpg` or `.webp` file one directory under `media/`, such as `media/gallery/world-cover.webp`, of at most 20 MB.";
    const settingMessage =
      "Value does not satisfy the toggle setting declared by probe";
    const settingHint =
      "Use a value allowed by this setting's type, range and options. Default: true.";
    expect(core).toEqual({
      worldId: "sample",
      diagnostics: [
        {
          level: "warning",
          code: "lore-narrator-only",
          file: "WORLD.md",
          pointer: "line 1",
          locales: ["en-US"],
          message: loreMessage,
          hint: loreHint,
        },
        {
          level: "error",
          code: "cover",
          file: hostPath,
          message: `\`cover\` names "${hostPath}", which the app cannot show`,
          hint: coverHint,
        },
        {
          level: "error",
          code: "invalid-setting",
          file: "world.yaml",
          pointer: "pluginSettings.probe.enabled",
          message: settingMessage,
          hint: settingHint,
        },
        {
          level: "warning",
          code: "unknown-setting",
          file: "world.yaml",
          pointer: `pluginSettings.probe.${hostPath}`,
          message: `plugin "probe" declares no setting "${hostPath}"; the value is ignored`,
          hint: "Declared settings: enabled.",
        },
      ],
    });
    expect(report).toEqual({
      kind: "world",
      id: "sample",
      ok: false,
      counts: { errors: 2, warnings: 2 },
      issues: [
        {
          severity: "warning",
          code: "lore-narrator-only",
          file: "WORLD.md",
          field: "line 1",
          message: `${loreMessage} (locale en-US)`,
          hint: loreHint,
        },
        {
          severity: "error",
          code: "cover",
          file: "<path>",
          message: '`cover` names "<path>", which the app cannot show',
          hint: coverHint,
        },
        {
          severity: "error",
          code: "invalid-setting",
          file: "world.yaml",
          field: "pluginSettings.probe.enabled",
          message: settingMessage,
          hint: settingHint,
        },
        {
          severity: "warning",
          code: "unknown-setting",
          file: "world.yaml",
          field: "pluginSettings.probe.<path>",
          message:
            'plugin "probe" declares no setting "<path>"; the value is ignored',
          hint: "Declared settings: enabled.",
        },
      ],
    });
    for (const prefix of [
      hostPath,
      root,
      os.tmpdir(),
      os.homedir(),
      path.join(root, "plugins"),
      path.join(root, "worlds"),
    ])
      expect(text).not.toContain(prefix);
    const withoutProvider = await validateWorldPackage({
      worldDir: dir,
      catalogue: createPluginRegistry(),
    });
    expect(withoutProvider.diagnostics.map((issue) => issue.code)).toEqual(
      expect.arrayContaining(["unknown-plugin", "unprovided-contract"]),
    );
    expect(
      withoutProvider.diagnostics.some(
        (issue) => issue.code === "invalid-setting",
      ),
    ).toBe(false);
  });
  it.each(["invalid", "missing"])(
    "reports structured diagnostics for an installed world's %s manifest",
    async (condition) => {
      const dir = path.join(root, "worlds/sample");
      await files(dir, { "world.yaml": world, "WORLD.md": "Lore" });
      expect(
        (await (await app.request("/api/install/worlds")).json()).items,
      ).toContainEqual({
        id: "sample",
        version: null,
        source: null,
        pendingUpdate: null,
      });
      if (condition === "invalid")
        await writeFile(path.join(dir, "world.yaml"), "name: [unterminated\n");
      else await rm(path.join(dir, "world.yaml"));
      const response = await post("world", { kind: "installed", id: "sample" });
      expect(response.status).toBe(200);
      const text = await response.text();
      expect(
        packageValidationReportSchema.parse(JSON.parse(text)),
      ).toMatchObject({
        kind: "world",
        id: "sample",
        ok: false,
        counts: { errors: 1, warnings: 0 },
        issues: [
          {
            severity: "error",
            code: "manifest-invalid",
            file: "world.yaml",
            message: expect.any(String),
          },
        ],
      });
      expect(text).not.toContain(root);
    },
  );
  it("retains ambiguity checks for unreadable installed worlds", async () => {
    for (const parent of ["worlds", "other-worlds"])
      await files(path.join(root, parent, "sample"), {
        "world.yaml": "name: [unterminated\n",
      });
    expect(
      (await post("world", { kind: "installed", id: "sample" })).status,
    ).toBe(409);
  });
  it.each([
    { escape: false, status: 400 },
    { escape: true, status: 403 },
  ])(
    "retains installed-world symlink checks, escape=$escape",
    async ({ escape, status }) => {
      const target = path.join(root, escape ? "outside" : "worlds/actual");
      await files(target, {
        "world.yaml": world.replace("id: sample", "id: actual"),
      });
      await mkdir(path.join(root, "worlds"), { recursive: true });
      await symlink(target, path.join(root, "worlds/sample"));
      expect(
        (await post("world", { kind: "installed", id: "sample" })).status,
      ).toBe(status);
    },
  );
  it.each([false, true])(
    "uses a static catalogue on a bare host, unavailable=%s",
    async (unavailable) => {
      const dir = path.join(root, "worlds/sample");
      await files(dir, { "world.yaml": world, "WORLD.md": "Lore" });
      vi.stubEnv("COVEL_PLUGINS_DIR", path.join(root, "plugins"));
      const sentinel = path.join(root, "fallback-executed");
      if (!unavailable) {
        await plugin({ entry: "./server/index.js" });
        await files(path.join(root, "plugins/probe"), {
          "server/index.js": `import fs from 'node:fs'; fs.writeFileSync(${JSON.stringify(sentinel)}, 'yes'); throw new Error('imported');`,
        });
      }
      const bare = new Hono();
      bare.route("/api/install", installRoutes);
      const response = await bare.request("/api/install/validate/world", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ source: { kind: "installed", id: "sample" } }),
      });
      expect(response.status).toBe(unavailable ? 503 : 200);
      if (!unavailable)
        expect(
          packageValidationReportSchema.parse(await response.json()).ok,
        ).toBe(true);
      await expect(access(sentinel)).rejects.toThrow();
    },
  );
  it("reports lorebook locations from a world ZIP without executing its code", async () => {
    const sentinel = path.join(root, "executed");
    const response = await upload(
      "world",
      await zip({
        "pack/world.yaml": world,
        "pack/WORLD.md": "Lore",
        "pack/data/lorebook.yaml":
          "- id: hidden\n  content: Hidden\n  strategy: selective\n",
        "pack/index.js": `import fs from 'node:fs'; fs.writeFileSync(${JSON.stringify(sentinel)}, 'yes'); throw new Error('imported')`,
      }),
    );
    expect(response.status).toBe(200);
    const report = packageValidationReportSchema.parse(await response.json());
    expect(report.ok).toBe(false);
    expect(report.issues).toContainEqual(
      expect.objectContaining({
        severity: "error",
        file: "data/lorebook.yaml",
      }),
    );
    await expect(access(sentinel)).rejects.toThrow();
  });
  it("never imports uploaded plugin entries", async () => {
    const sentinel = path.join(root, "executed");
    const response = await upload(
      "plugin",
      await zip({
        "PLUGIN.md": manifest({ entry: "./server/index.js" }),
        "server/index.js": `import fs from 'node:fs'; fs.writeFileSync(${JSON.stringify(sentinel)}, 'yes'); throw new Error('imported')`,
      }),
    );
    expect(response.status).toBe(200);
    const report = await response.json();
    expect(report.ok, JSON.stringify(report)).toBe(true);
    await expect(access(sentinel)).rejects.toThrow();
  });
  it("caps issues and messages and keeps a schema-consistent failing verdict", async () => {
    await plugin(
      Object.fromEntries(
        Array.from({ length: 300 }, (_, index) => [`unknown${index}`, true]),
      ),
    );
    const report = packageValidationReportSchema.parse(
      await (await post("plugin", { kind: "installed", id: "probe" })).json(),
    );
    expect(report.issues).toHaveLength(201);
    expect(report.issues.at(-1)).toMatchObject({
      code: "issues-truncated",
      severity: "warning",
    });
    expect(report.ok).toBe(false);
    const bounded = validationReport("plugin", root, [
      { severity: "error", code: "long", message: "x".repeat(4000) },
    ]);
    expect(bounded.issues[0]?.message).toHaveLength(2000);
  });
  it("preserves error locations and verdicts when warnings fill the response cap", () => {
    const issues = Array.from({ length: 200 }, () => ({
      severity: "warning" as const,
      code: "w",
      message: "Warning",
    }));
    const report = validationReport("world", root, [
      ...issues,
      {
        severity: "error",
        code: "world-data",
        file: "data/lorebook.yaml",
        field: "[0]",
        message: "Invalid entry",
        hint: "Add keys",
      },
    ]);
    expect(packageValidationReportSchema.parse(report).ok).toBe(false);
    expect(report.issues).toHaveLength(201);
    expect(report.issues).toContainEqual({
      severity: "error",
      code: "world-data",
      file: "data/lorebook.yaml",
      field: "[0]",
      message: "Invalid entry",
      hint: "Add keys",
    });
  });
  it("queues simultaneous HTTP requests in arrival order", async () => {
    await plugin();
    const order: number[] = [];
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const original = serialQueue.runSerial;
    let arrival = 0;
    const spy = vi
      .spyOn(serialQueue, "runSerial")
      .mockImplementation(<T>(fn: () => Promise<T>): Promise<T> => {
        const number = ++arrival;
        return original(async () => {
          order.push(number);
          if (number === 1) await gate;
          return fn();
        });
      });
    const first = post("plugin", { kind: "installed", id: "probe" });
    await vi.waitFor(() => expect(spy).toHaveBeenCalledTimes(1));
    const second = post("plugin", { kind: "installed", id: "probe" });
    await vi.waitFor(() => expect(spy).toHaveBeenCalledTimes(2));
    expect(order).toEqual([1]);
    release();
    expect(
      (await Promise.all([first, second])).map((response) => response.status),
    ).toEqual([200, 200]);
    expect(order).toEqual([1, 2]);
  });
  it("cleans up an upload even if its queued validation rejects", async () => {
    const before = new Set(await readdir(os.tmpdir()));
    vi.spyOn(serialQueue, "runSerial").mockRejectedValueOnce(
      new Error("Failed at /private/host/secret/path"),
    );
    const response = await upload(
      "plugin",
      await zip({ "PLUGIN.md": manifest() }),
    );
    expect(response.status).toBe(500);
    expect(await response.text()).not.toContain("/private");
    expect(
      (await readdir(os.tmpdir())).filter(
        (name) => name.startsWith("covel-validate-") && !before.has(name),
      ),
    ).toEqual([]);
  });
  it("accepts paths inside a root", async () => {
    const dir = await plugin();
    expect((await post("plugin", { kind: "path", path: dir })).status).toBe(
      200,
    );
  });
  it("rejects outside paths and symlink escapes before disclosing locations", async () => {
    const dir = await plugin();
    await symlink(root, path.join(dir, "escape"));
    for (const target of [root, path.join(dir, "escape")]) {
      const response = await post("plugin", { kind: "path", path: target });
      expect(response.status).toBe(403);
      expect(await response.text()).toContain("path-outside-roots");
    }
  });
  it("rejects symlinked roots and file paths", async () => {
    const dir = await plugin();
    const link = path.join(root, "plugins/link");
    await symlink(dir, link);
    for (const target of [link, path.join(dir, "PLUGIN.md")])
      expect(
        (await post("plugin", { kind: "path", path: target })).status,
      ).toBe(400);
  });
  it.each(["../bad", "Bad", "", "a/b"])("rejects unsafe ids: %s", async (id) =>
    expect((await post("plugin", { kind: "installed", id })).status).toBe(400),
  );
  it.each(["plugin", "world"] as const)(
    "returns 404 for missing %s",
    async (kind) =>
      expect(
        (await post(kind, { kind: "installed", id: "absent" })).status,
      ).toBe(404),
  );
  it("rejects unknown source kinds and malformed JSON", async () => {
    expect((await post("plugin", { kind: "remote" })).status).toBe(400);
    expect(
      (
        await app.request("/api/install/validate/plugin", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: "{",
        })
      ).status,
    ).toBe(400);
  });
  it("refuses ambiguous world identities", async () => {
    for (const parent of ["worlds", "other-worlds"])
      await files(path.join(root, parent, "sample"), { "world.yaml": world });
    expect(
      (await post("world", { kind: "installed", id: "sample" })).status,
    ).toBe(409);
  });
  it("rejects non-ZIP, missing manifests, receipts and excessive uploads", async () => {
    expect((await upload("plugin", Buffer.from("not zip"))).status).toBe(400);
    expect(
      (await upload("world", await zip({ "other.txt": "text" }))).status,
    ).toBe(400);
    expect(
      (
        await upload(
          "plugin",
          await zip({ "PLUGIN.md": manifest(), ".covel-install.json": "{}" }),
        )
      ).status,
    ).toBe(400);
    expect(
      (
        await app.request("/api/install/validate/plugin", {
          method: "POST",
          headers: { "Content-Length": String(21 * 1024 * 1024) },
        })
      ).status,
    ).toBe(413);
  });
  it.each(["plugin", "world"] as const)(
    "requires the hosted operator token for %s",
    async (kind) => {
      const hosted = new Hono();
      const profile = deriveHostProfile(
        {
          ...readRuntimeEnv(),
          deploymentTier: "demo",
          desktopRestToken: "secret",
          mediaTokenSecret: "secret",
        },
        { storeBackend: "memory" },
      );
      hosted.use("*", async (c, next) => {
        c.set("hostProfile", profile);
        await next();
      });
      hosted.route("/api/install", installRoutes);
      const response = await hosted.request(`/api/install/validate/${kind}`, {
        method: "POST",
      });
      expect(response.status).toBe(401);
    },
  );
});

it("serialises simultaneous validations and continues after a rejection", async () => {
  const calls: number[] = [];
  let release = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const first = runSerial(async () => {
    calls.push(1);
    await gate;
    calls.push(2);
  });
  const second = runSerial(async () => {
    calls.push(3);
    throw new Error("failed");
  });
  const caught = expect(second).rejects.toThrow("failed");
  const third = runSerial(async () => calls.push(4));
  await Promise.resolve();
  expect(calls).toEqual([1]);
  release();
  await Promise.all([first, caught, third]);
  expect(calls).toEqual([1, 2, 3, 4]);
});
