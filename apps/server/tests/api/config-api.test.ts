import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
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

  it("round-trips settings.json and recovers from malformed settings", async () => {
    process.env.COVEL_HOME = tmpHome;
    const app = buildApp(apiKeys);

    const putRes = await app.request("/api/config/settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ entries: { theme: "dark", modelSlot: "story" } }),
    });
    expect(putRes.status).toBe(200);

    const getBody = (await (
      await app.request("/api/config/settings")
    ).json()) as Record<string, unknown>;
    expect(getBody).toMatchObject({
      schemaVersion: 1,
      entries: { theme: "dark", modelSlot: "story" },
    });
    expect(typeof getBody.savedAt).toBe("string");

    fs.writeFileSync(path.join(tmpHome, "settings.json"), "{bad json");
    await expect(
      (await app.request("/api/config/settings")).json(),
    ).resolves.toEqual({
      schemaVersion: 1,
      savedAt: "",
      entries: {},
    });
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

    it("gates settings, data-root, and open-folder writes with the same token", async () => {
      process.env.COVEL_HOME = tmpHome;
      process.env.COVEL_DESKTOP_REST_TOKEN = TOKEN;
      const app = buildApp(apiKeys);

      const settingsRes = await app.request("/api/config/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ entries: { theme: "dark" } }),
      });
      expect(settingsRes.status).toBe(401);

      const dataRootRes = await app.request("/api/config/data-root", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: path.join(tmpHome, "new-data") }),
      });
      expect(dataRootRes.status).toBe(401);

      const openRes = await app.request("/api/config/open-folder", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ target: "config" }),
      });
      expect(openRes.status).toBe(401);
    });

    it("gates GET /api/config/settings with the same token", async () => {
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
