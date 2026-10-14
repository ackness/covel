import {
  mkdtemp,
  mkdir,
  rm,
  access,
  readFile,
  readdir,
  rename,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PluginRegistry } from "@covel/plugin-loader";
import { pluginRoutes } from "../../src/routes/api/plugins.js";
import { cleanupPackageStaging } from "../../src/routes/api/install/package-staging.js";
import { discoverPluginsMulti } from "@covel/plugin-loader";

vi.mock("node:fs/promises", async (importOriginal) => {
  const fs = await importOriginal<typeof import("node:fs/promises")>();
  return { ...fs, rm: vi.fn(fs.rm), rename: vi.fn(fs.rename) };
});

let pluginsDir: string;
let prevUserPluginsDir: string | undefined;
let prevDesktopRestToken: string | undefined;
let prevInstallApiEnabled: string | undefined;
let prevNodeEnv: string | undefined;

// Minimal registry stub — the uninstall route only reads `get(id)?.source`.
function makeRegistry(builtinIds: string[] = ["narrator"]): PluginRegistry {
  return {
    get: (id: string) =>
      builtinIds.includes(id) ? { source: "builtin" } : undefined,
    getAll: () => new Map(),
  } as unknown as PluginRegistry;
}

function createTestApp(registry: PluginRegistry = makeRegistry()): Hono {
  const app = new Hono();
  app.use("*", async (c, next) => {
    c.set("pluginRegistry", registry);
    await next();
  });
  app.route("/api/plugins", pluginRoutes);
  return app;
}

beforeEach(async () => {
  pluginsDir = await mkdtemp(path.join(tmpdir(), "covel-uninstall-"));
  prevUserPluginsDir = process.env.COVEL_USER_PLUGINS_DIR;
  prevDesktopRestToken = process.env.COVEL_DESKTOP_REST_TOKEN;
  prevInstallApiEnabled = process.env.COVEL_INSTALL_API_ENABLED;
  prevNodeEnv = process.env.NODE_ENV;
  process.env.COVEL_USER_PLUGINS_DIR = pluginsDir;
  delete process.env.COVEL_DESKTOP_REST_TOKEN;
  delete process.env.COVEL_INSTALL_API_ENABLED;
  process.env.NODE_ENV = "test";
});

afterEach(async () => {
  vi.restoreAllMocks();
  const fs =
    await vi.importActual<typeof import("node:fs/promises")>(
      "node:fs/promises",
    );
  vi.mocked(rm).mockImplementation(fs.rm);
  vi.mocked(rename).mockImplementation(fs.rename);
  if (prevUserPluginsDir === undefined) {
    delete process.env.COVEL_USER_PLUGINS_DIR;
  } else {
    process.env.COVEL_USER_PLUGINS_DIR = prevUserPluginsDir;
  }
  if (prevDesktopRestToken === undefined) {
    delete process.env.COVEL_DESKTOP_REST_TOKEN;
  } else {
    process.env.COVEL_DESKTOP_REST_TOKEN = prevDesktopRestToken;
  }
  if (prevInstallApiEnabled === undefined) {
    delete process.env.COVEL_INSTALL_API_ENABLED;
  } else {
    process.env.COVEL_INSTALL_API_ENABLED = prevInstallApiEnabled;
  }
  if (prevNodeEnv === undefined) {
    delete process.env.NODE_ENV;
  } else {
    process.env.NODE_ENV = prevNodeEnv;
  }
  await rm(pluginsDir, { recursive: true, force: true });
});

describe("DELETE /api/plugins/:id (uninstall)", () => {
  it("keeps a complete package when the initial rename fails", async () => {
    const dir = path.join(pluginsDir, "my-plugin");
    await mkdir(dir);
    await writeFile(path.join(dir, "PLUGIN.md"), "manifest");
    await writeFile(path.join(dir, "handler.js"), "handler");
    vi.mocked(rename).mockRejectedValueOnce(
      new Error("Synthetic rename failure"),
    );
    const app = createTestApp();
    app.onError(() => new Response("Rename failed", { status: 500 }));
    expect(
      (await app.request("/api/plugins/my-plugin", { method: "DELETE" }))
        .status,
    ).toBe(500);
    expect(await readFile(path.join(dir, "PLUGIN.md"), "utf8")).toBe(
      "manifest",
    );
    expect(await readFile(path.join(dir, "handler.js"), "utf8")).toBe(
      "handler",
    );
    expect(await readdir(pluginsDir)).toEqual(["my-plugin"]);
  });

  it("does not rediscover a partially deleted package and retries cleanup at startup", async () => {
    const dir = path.join(pluginsDir, "my-plugin");
    await mkdir(dir);
    await writeFile(
      path.join(dir, "PLUGIN.md"),
      "---\nid: my-plugin\nkind: plugin\n---\n",
    );
    await writeFile(path.join(dir, "handler.js"), "handler");
    const fs =
      await vi.importActual<typeof import("node:fs/promises")>(
        "node:fs/promises",
      );
    vi.mocked(rm).mockImplementationOnce(async (target) => {
      // Simulate a real recursive deletion that removed code before a locked file failed.
      const packageDir =
        String(target) === dir ? dir : path.join(String(target), "package");
      await fs.rm(path.join(packageDir, "handler.js"));
      throw new Error("Synthetic locked manifest");
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const response = await createTestApp().request("/api/plugins/my-plugin", {
      method: "DELETE",
    });
    expect(response.status).toBe(200);
    await expect(access(dir)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await discoverPluginsMulti([pluginsDir])).toEqual([]);
    expect(await readdir(pluginsDir)).toEqual([
      expect.stringMatching(/^\.covel-uninstall-/),
    ]);
    expect(warn).toHaveBeenCalled();
    await cleanupPackageStaging(pluginsDir);
    expect(await readdir(pluginsDir)).toEqual([]);
  });

  it("removes an installed third-party plugin dir and reports restartRequired", async () => {
    const dir = path.join(pluginsDir, "my-plugin");
    await mkdir(dir, { recursive: true });
    const app = createTestApp();

    const res = await app.request("/api/plugins/my-plugin", {
      method: "DELETE",
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toMatchObject({
      ok: true,
      id: "my-plugin",
      restartRequired: true,
    });
    await expect(access(dir)).rejects.toThrow(); // dir is gone
  });

  it("requires explicit production opt-in when no bearer token is configured", async () => {
    process.env.NODE_ENV = "production";
    const dir = path.join(pluginsDir, "my-plugin");
    await mkdir(dir, { recursive: true });
    const app = createTestApp();

    const blocked = await app.request("/api/plugins/my-plugin", {
      method: "DELETE",
    });

    expect(blocked.status).toBe(403);
    await expect(blocked.json()).resolves.toMatchObject({
      code: "install_api_disabled",
    });
    await access(dir);
  });

  it("rejects a missing desktop bearer token", async () => {
    process.env.COVEL_DESKTOP_REST_TOKEN = "uninstall-token";
    const dir = path.join(pluginsDir, "my-plugin");
    await mkdir(dir, { recursive: true });
    const app = createTestApp();

    const res = await app.request("/api/plugins/my-plugin", {
      method: "DELETE",
    });

    expect(res.status).toBe(401);
    await expect(res.json()).resolves.toMatchObject({
      code: "desktop_rest_token_invalid",
    });
    await access(dir);
  });

  it("rejects an invalid desktop bearer token", async () => {
    process.env.COVEL_DESKTOP_REST_TOKEN = "uninstall-token";
    const dir = path.join(pluginsDir, "my-plugin");
    await mkdir(dir, { recursive: true });
    const app = createTestApp();

    const res = await app.request("/api/plugins/my-plugin", {
      method: "DELETE",
      headers: { Authorization: "Bearer wrong-token" },
    });

    expect(res.status).toBe(401);
    await access(dir);
  });

  it("accepts a valid desktop bearer token", async () => {
    process.env.NODE_ENV = "production";
    process.env.COVEL_DESKTOP_REST_TOKEN = "uninstall-token";
    const dir = path.join(pluginsDir, "my-plugin");
    await mkdir(dir, { recursive: true });
    const app = createTestApp();

    const res = await app.request("/api/plugins/my-plugin", {
      method: "DELETE",
      headers: { Authorization: "Bearer uninstall-token" },
    });

    expect(res.status).toBe(200);
    await expect(access(dir)).rejects.toThrow();
  });

  it("rejects uninstalling a builtin plugin with 409", async () => {
    // Even if a dir somehow exists, a builtin id must never be removed.
    await mkdir(path.join(pluginsDir, "narrator"), { recursive: true });
    const app = createTestApp(makeRegistry(["narrator"]));

    const res = await app.request("/api/plugins/narrator", {
      method: "DELETE",
    });

    expect(res.status).toBe(409);
    // The dir survives.
    await access(path.join(pluginsDir, "narrator"));
  });

  it("returns 404 when the plugin is not installed", async () => {
    const app = createTestApp();
    const res = await app.request("/api/plugins/ghost", { method: "DELETE" });
    expect(res.status).toBe(404);
  });

  it("rejects an invalid plugin id with 400", async () => {
    const app = createTestApp();
    const res = await app.request("/api/plugins/bad.name", {
      method: "DELETE",
    });
    expect(res.status).toBe(400);
  });

  it("rejects path-traversal ids and never deletes outside the plugins root", async () => {
    // A sibling directory outside the user plugins root — must survive.
    const outside = path.join(path.dirname(pluginsDir), "OUTSIDE-SECRET");
    await mkdir(outside, { recursive: true });
    const app = createTestApp();

    // Each id contains "/" and/or "." which PLUGIN_ID_RE rejects before any
    // filesystem access; the path.relative() guard is the second line. Whether
    // Hono decodes %2F or not, the param never satisfies the id regex.
    for (const id of [
      encodeURIComponent("../OUTSIDE-SECRET"),
      encodeURIComponent("../../OUTSIDE-SECRET"),
      "..%2F..%2FOUTSIDE-SECRET",
    ]) {
      const res = await app.request(`/api/plugins/${id}`, { method: "DELETE" });
      expect(res.status, `id=${id}`).toBe(400);
    }

    // The outside directory is untouched.
    await access(outside);
    await rm(outside, { recursive: true, force: true });
  });
});
