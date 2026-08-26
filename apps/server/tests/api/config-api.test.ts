import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { createConfigApiRoutes } from "../../src/routes/config-api.js";

const ENV_KEYS = [
  "COVEL_HOME",
  "COVEL_DESKTOP_REST",
  "COVEL_DESKTOP_REST_TOKEN",
  "COVEL_DATA_ROOT",
  "SQLITE_PATH",
  "COVEL_LOGS_DIR",
  "COVEL_LLM_TOML",
  "COVEL_USER_PLUGINS_DIR",
  "COVEL_USER_WORLDS_DIR",
  "COVEL_SYSTEM_PROXY_URL",
] as const;

function buildApp(apiKeys: Record<string, string>): Hono {
  const app = new Hono();
  app.route("/", createConfigApiRoutes({ apiKeys }));
  return app;
}

describe("config API env and file contracts", () => {
  let tmpHome: string;
  let apiKeys: Record<string, string>;
  const savedEnv: Partial<
    Record<(typeof ENV_KEYS)[number], string | undefined>
  > = {};

  beforeEach(() => {
    for (const key of ENV_KEYS) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "covel-config-api-"));
    apiKeys = {};
  });

  afterEach(() => {
    vi.restoreAllMocks();
    for (const key of ENV_KEYS) {
      if (savedEnv[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = savedEnv[key];
      }
    }
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  it("reports non-desktop mode without exposing local config paths", async () => {
    const app = buildApp(apiKeys);

    const res = await app.request("/api/config/info");

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      isDesktop: false,
      covelHome: null,
      dataRoot: null,
      keysEnvPath: null,
      dbPath: "./data/covel.db",
      logsDir: null,
      llmTomlPath: null,
      pluginsDir: null,
      worldsDir: null,
    });
  });

  it("reports desktop paths from runtime env", async () => {
    process.env.COVEL_HOME = tmpHome;
    process.env.COVEL_DATA_ROOT = path.join(tmpHome, "data-root");
    process.env.SQLITE_PATH = path.join(tmpHome, "data", "covel.db");
    process.env.COVEL_LOGS_DIR = path.join(tmpHome, "logs");
    process.env.COVEL_LLM_TOML = path.join(tmpHome, "llm.toml");
    process.env.COVEL_USER_PLUGINS_DIR = path.join(tmpHome, "plugins");
    process.env.COVEL_USER_WORLDS_DIR = path.join(tmpHome, "worlds");
    const app = buildApp(apiKeys);

    const body = (await (
      await app.request("/api/config/info")
    ).json()) as Record<string, unknown>;

    expect(body).toMatchObject({
      isDesktop: true,
      covelHome: tmpHome,
      dataRoot: path.join(tmpHome, "data-root"),
      dbPath: path.join(tmpHome, "data", "covel.db"),
      logsDir: path.join(tmpHome, "logs"),
      llmTomlPath: path.join(tmpHome, "llm.toml"),
      keysEnvPath: path.join(tmpHome, "keys.env"),
      pluginsDir: path.join(tmpHome, "plugins"),
      worldsDir: path.join(tmpHome, "worlds"),
    });
  });

  it("keeps key persistence disabled outside desktop mode", async () => {
    const app = buildApp(apiKeys);

    const listRes = await app.request("/api/config/keys");
    expect(listRes.status).toBe(200);
    await expect(listRes.json()).resolves.toEqual({ providers: [] });

    const putRes = await app.request("/api/config/keys", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ deepseek: "sk-test" }),
    });
    expect(putRes.status).toBe(400);
    expect(apiKeys).toEqual({});
  });

  it("writes keys.env, normalizes provider ids and updates the live apiKeys map", async () => {
    process.env.COVEL_HOME = tmpHome;
    const app = buildApp(apiKeys);

    const putRes = await app.request("/api/config/keys", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        deepseek: " sk-deepseek ",
        OPEN_ROUTER_API_KEY: "sk-open-router",
        invalidEmpty: "",
      }),
    });

    expect(putRes.status).toBe(200);
    expect(apiKeys).toEqual({
      deepseek: "sk-deepseek",
      "open-router": "sk-open-router",
    });
    const file = fs.readFileSync(path.join(tmpHome, "keys.env"), "utf-8");
    expect(file).toContain("DEEPSEEK_API_KEY=sk-deepseek");
    expect(file).toContain("OPEN_ROUTER_API_KEY=sk-open-router");
    expect(file).not.toContain("invalidEmpty");

    const listBody = (await (await app.request("/api/config/keys")).json()) as {
      providers: string[];
    };
    expect(listBody.providers.sort()).toEqual(["deepseek", "open-router"]);
    expect(JSON.stringify(listBody)).not.toContain("sk-");
  });

  it("removes keys from file and live apiKeys map when value is empty", async () => {
    process.env.COVEL_HOME = tmpHome;
    fs.writeFileSync(
      path.join(tmpHome, "keys.env"),
      "DEEPSEEK_API_KEY=old\nOPEN_ROUTER_API_KEY=old-open\n",
    );
    apiKeys.deepseek = "old";
    apiKeys["open-router"] = "old-open";
    const app = buildApp(apiKeys);

    const res = await app.request("/api/config/keys", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ deepseek: "", "open-router": null }),
    });

    expect(res.status).toBe(200);
    expect(apiKeys).toEqual({});
    expect(
      fs.readFileSync(path.join(tmpHome, "keys.env"), "utf-8"),
    ).not.toContain("_API_KEY=");
  });

  it("refuses to replace an unreadable keys.env", async () => {
    process.env.COVEL_HOME = tmpHome;
    const keysPath = path.join(tmpHome, "keys.env");
    fs.mkdirSync(keysPath);
    const app = buildApp(apiKeys);

    const getRes = await app.request("/api/config/keys");
    expect(getRes.status).toBe(500);
    await expect(getRes.json()).resolves.toMatchObject({
      code: "keys_file_unreadable",
    });

    const putRes = await app.request("/api/config/keys", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ deepseek: "new-secret" }),
    });
    expect(putRes.status).toBe(409);
    expect(fs.statSync(keysPath).isDirectory()).toBe(true);
    expect(apiKeys).toEqual({});
  });

  it("round-trips settings.json and refuses to overwrite malformed settings", async () => {
    process.env.COVEL_HOME = tmpHome;
    const app = buildApp(apiKeys);

    const putRes = await app.request("/api/config/settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        entries: { theme: "dark", modelSlot: "story" },
        expectedRevision: 0,
      }),
    });
    expect(putRes.status).toBe(200);

    const getBody = (await (
      await app.request("/api/config/settings")
    ).json()) as Record<string, unknown>;
    expect(getBody).toMatchObject({
      schemaVersion: 2,
      revision: 1,
      entries: { theme: "dark", modelSlot: "story" },
    });
    expect(typeof getBody.savedAt).toBe("string");

    const staleWrite = await app.request("/api/config/settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        entries: { theme: "light" },
        expectedRevision: 0,
      }),
    });
    expect(staleWrite.status).toBe(409);
    await expect(staleWrite.json()).resolves.toMatchObject({
      code: "settings_revision_conflict",
      details: { revision: 1 },
    });

    fs.writeFileSync(path.join(tmpHome, "settings.json"), "{bad json");
    const malformedGet = await app.request("/api/config/settings");
    expect(malformedGet.status).toBe(500);
    await expect(malformedGet.json()).resolves.toMatchObject({
      code: "settings_file_invalid",
    });

    const overwrite = await app.request("/api/config/settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        entries: { theme: "light" },
        expectedRevision: 1,
      }),
    });
    expect(overwrite.status).toBe(409);
    expect(fs.readFileSync(path.join(tmpHome, "settings.json"), "utf-8")).toBe(
      "{bad json",
    );
  });

  it("rewrites data_root only for absolute paths", async () => {
    process.env.COVEL_HOME = tmpHome;
    const app = buildApp(apiKeys);

    const relativeRes = await app.request("/api/config/data-root", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: "relative/path" }),
    });
    expect(relativeRes.status).toBe(400);

    const absolutePath = path.join(tmpHome, "new-data");
    const okRes = await app.request("/api/config/data-root", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: absolutePath }),
    });
    expect(okRes.status).toBe(200);
    await expect(okRes.json()).resolves.toEqual({
      ok: true,
      restartRequired: true,
    });

    const configToml = fs.readFileSync(
      path.join(tmpHome, "config.toml"),
      "utf-8",
    );
    expect(configToml).toContain(
      `[paths]\ndata_root = ${JSON.stringify(absolutePath)}`,
    );
  });

  it("preserves config.toml text and refuses data_root patches on corrupt TOML", async () => {
    process.env.COVEL_HOME = tmpHome;
    const configPath = path.join(tmpHome, "config.toml");
    fs.writeFileSync(
      configPath,
      [
        "# operator note",
        "[paths]",
        "data_root = '/old' # keep inline note",
        "[custom]",
        "enabled = true",
        "",
      ].join("\n"),
      "utf-8",
    );
    const app = buildApp(apiKeys);

    const replacement = path.join(tmpHome, "next-data");
    const ok = await app.request("/api/config/data-root", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: replacement }),
    });
    expect(ok.status).toBe(200);
    const updated = fs.readFileSync(configPath, "utf-8");
    expect(updated).toContain("# operator note");
    expect(updated).toContain(
      `data_root = ${JSON.stringify(replacement)} # keep inline note`,
    );
    expect(updated).toContain("[custom]\nenabled = true");

    const corrupt = "[paths\ndata_root = 'recover-me'\n";
    fs.writeFileSync(configPath, corrupt, "utf-8");
    const rejected = await app.request("/api/config/data-root", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: path.join(tmpHome, "must-not-win") }),
    });
    expect(rejected.status).toBe(500);
    await expect(rejected.json()).resolves.toMatchObject({
      code: "config_write_failed",
    });
    expect(fs.readFileSync(configPath, "utf-8")).toBe(corrupt);
  });

  it("persists and hot-applies the compact desktop proxy setting", async () => {
    process.env.COVEL_HOME = tmpHome;
    process.env.COVEL_SYSTEM_PROXY_URL = "http://127.0.0.1:7890";
    const app = buildApp(apiKeys);

    const putRes = await app.request("/api/config/proxy", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode: "socks", url: "127.0.0.1:7891" }),
    });
    expect(putRes.status).toBe(200);
    await expect(putRes.json()).resolves.toMatchObject({
      mode: "socks",
      url: "socks5://127.0.0.1:7891",
      effective: "proxy",
      systemAvailable: true,
    });

    const configToml = fs.readFileSync(
      path.join(tmpHome, "config.toml"),
      "utf-8",
    );
    expect(configToml).toContain("[network]");
    expect(configToml).toContain('proxy_mode = "socks"');
    expect(configToml).toContain('proxy_url = "socks5://127.0.0.1:7891"');

    const getRes = await app.request("/api/config/proxy");
    expect(getRes.status).toBe(200);
    await expect(getRes.json()).resolves.toMatchObject({
      mode: "socks",
      url: "socks5://127.0.0.1:7891",
    });
  });

  it("rejects a mismatched proxy type without changing config.toml", async () => {
    process.env.COVEL_HOME = tmpHome;
    const app = buildApp(apiKeys);

    const res = await app.request("/api/config/proxy", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        mode: "http",
        url: "socks5://127.0.0.1:7891",
      }),
    });

    expect(res.status).toBe(400);
    expect(fs.existsSync(path.join(tmpHome, "config.toml"))).toBe(false);
  });

  it("refuses to hot-apply or overwrite proxy settings from corrupt TOML", async () => {
    process.env.COVEL_HOME = tmpHome;
    const configPath = path.join(tmpHome, "config.toml");
    const corrupt = "[network\nproxy_mode = 'direct'\n";
    fs.writeFileSync(configPath, corrupt, "utf-8");
    const app = buildApp(apiKeys);

    const res = await app.request("/api/config/proxy", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode: "http", url: "127.0.0.1:7890" }),
    });

    expect(res.status).toBe(400);
    expect(fs.readFileSync(configPath, "utf-8")).toBe(corrupt);
  });

  it("validates the proxy dispatcher before changing config.toml", async () => {
    process.env.COVEL_HOME = tmpHome;
    const configPath = path.join(tmpHome, "config.toml");
    const original = '[paths]\ndata_root = "/existing/data"\n';
    fs.writeFileSync(configPath, original, "utf-8");
    const app = buildApp(apiKeys);

    const res = await app.request("/api/config/proxy", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        mode: "http",
        url: "http://user%ZZ:pass@127.0.0.1:7890",
      }),
    });

    expect(res.status).toBe(400);
    expect(fs.readFileSync(configPath, "utf-8")).toBe(original);
  });

  it("falls back to direct when a stored proxy cannot initialize", async () => {
    process.env.COVEL_HOME = tmpHome;
    const configPath = path.join(tmpHome, "config.toml");
    fs.writeFileSync(
      configPath,
      '[network]\nproxy_mode = "http"\n' +
        'proxy_url = "http://user%ZZ:pass@127.0.0.1:7890"\n',
      "utf-8",
    );
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    const app = buildApp(apiKeys);
    const res = await app.request("/api/config/proxy");

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      mode: "direct",
      effective: "direct",
    });
    expect(fs.readFileSync(configPath, "utf-8")).toContain("user%ZZ");
    expect(warn).toHaveBeenCalledWith(
      "[proxy-config] Ignoring invalid stored proxy settings:",
      expect.anything(),
    );
  });

  // ── Desktop REST bearer token guard ────────────────────────────
  //
  // When the desktop shell injects COVEL_DESKTOP_REST_TOKEN into the sidecar
  // env, every privileged write must carry a matching `Authorization: Bearer
  // <token>` header. `/api/config/info` advertises `requiresAuth: true` so
  // the renderer attaches the header for privileged calls.
  describe("desktop REST bearer token guard", () => {
    const TOKEN = "token-deadbeefcafebabe";

    it("advertises requiresAuth on /api/config/info when token is set", async () => {
      process.env.COVEL_HOME = tmpHome;
      process.env.COVEL_DESKTOP_REST_TOKEN = TOKEN;
      const app = buildApp(apiKeys);

      const body = (await (await app.request("/api/config/info")).json()) as {
        requiresAuth?: boolean;
      };
      expect(body.requiresAuth).toBe(true);
    });

    it("reports requiresAuth: false when token is absent", async () => {
      process.env.COVEL_HOME = tmpHome;
      const app = buildApp(apiKeys);

      const body = (await (await app.request("/api/config/info")).json()) as {
        requiresAuth?: boolean;
      };
      expect(body.requiresAuth).toBe(false);
    });

    it("rejects PUT /api/config/keys without Authorization header", async () => {
      process.env.COVEL_HOME = tmpHome;
      process.env.COVEL_DESKTOP_REST_TOKEN = TOKEN;
      const app = buildApp(apiKeys);

      const res = await app.request("/api/config/keys", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ deepseek: "sk-test" }),
      });

      expect(res.status).toBe(401);
      expect(apiKeys).toEqual({});
      expect(fs.existsSync(path.join(tmpHome, "keys.env"))).toBe(false);
    });

    it("keeps the non-secret provider list readable without Authorization", async () => {
      process.env.COVEL_HOME = tmpHome;
      process.env.COVEL_DESKTOP_REST_TOKEN = TOKEN;
      fs.writeFileSync(
        path.join(tmpHome, "keys.env"),
        "DEEPSEEK_API_KEY=secret\n",
      );
      const app = buildApp(apiKeys);

      const response = await app.request("/api/config/keys");
      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual({
        providers: ["deepseek"],
      });
    });

    it("rejects PUT /api/config/keys with a wrong token", async () => {
      process.env.COVEL_HOME = tmpHome;
      process.env.COVEL_DESKTOP_REST_TOKEN = TOKEN;
      const app = buildApp(apiKeys);

      const res = await app.request("/api/config/keys", {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer wrong-token",
        },
        body: JSON.stringify({ deepseek: "sk-test" }),
      });

      expect(res.status).toBe(401);
      expect(apiKeys).toEqual({});
    });

    it("accepts PUT /api/config/keys with the correct bearer token", async () => {
      process.env.COVEL_HOME = tmpHome;
      process.env.COVEL_DESKTOP_REST_TOKEN = TOKEN;
      const app = buildApp(apiKeys);

      const res = await app.request("/api/config/keys", {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${TOKEN}`,
        },
        body: JSON.stringify({ deepseek: "sk-test" }),
      });

      expect(res.status).toBe(200);
      expect(apiKeys).toEqual({ deepseek: "sk-test" });
    });

    it("gates settings, proxy, data-root, and open-folder writes with the same token", async () => {
      process.env.COVEL_HOME = tmpHome;
      process.env.COVEL_DESKTOP_REST_TOKEN = TOKEN;
      const app = buildApp(apiKeys);

      const settingsRes = await app.request("/api/config/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          entries: { theme: "dark" },
          expectedRevision: 0,
        }),
      });
      expect(settingsRes.status).toBe(401);

      const dataRootRes = await app.request("/api/config/data-root", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: path.join(tmpHome, "new-data") }),
      });
      expect(dataRootRes.status).toBe(401);

      const proxyRes = await app.request("/api/config/proxy", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode: "direct" }),
      });
      expect(proxyRes.status).toBe(401);

      const openRes = await app.request("/api/config/open-folder", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ target: "config" }),
      });
      expect(openRes.status).toBe(401);
    });

    it("gates sensitive config reads with the same token", async () => {
      process.env.COVEL_HOME = tmpHome;
      process.env.COVEL_DESKTOP_REST_TOKEN = TOKEN;
      fs.writeFileSync(
        path.join(tmpHome, "settings.json"),
        JSON.stringify({
          schemaVersion: 1,
          savedAt: "now",
          entries: { importedSecret: "sk-test" },
        }),
      );
      const app = buildApp(apiKeys);

      expect((await app.request("/api/config/settings")).status).toBe(401);
      expect((await app.request("/api/config/proxy")).status).toBe(401);
      const okRes = await app.request("/api/config/settings", {
        headers: { Authorization: `Bearer ${TOKEN}` },
      });
      expect(okRes.status).toBe(200);
      await expect(okRes.json()).resolves.toMatchObject({
        entries: { importedSecret: "sk-test" },
      });
    });

    it("keeps public config reads available when the token is required", async () => {
      process.env.COVEL_HOME = tmpHome;
      process.env.COVEL_DESKTOP_REST_TOKEN = TOKEN;
      const app = buildApp(apiKeys);

      expect((await app.request("/api/config/info")).status).toBe(200);
      expect((await app.request("/api/config/keys")).status).toBe(200);
    });
  });
});
