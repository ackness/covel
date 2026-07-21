import { describe, expect, it, vi } from "vitest";

import {
  COVEL_FEATURE_FLAGS,
  COVEL_ENV_REGISTRY,
  getEnvDefinition,
  isEnvDefaultOn,
  isEnvEnabled,
  isEnvTruthy,
  providerApiKeysFromEnv,
  providerApiKeyEnvName,
  readEnvCsv,
  readEnvInt,
  readEnvString,
  readEnvChoice,
  readRuntimeEnv,
} from "../src/env/index.js";

describe("env registry", () => {
  it("keeps names unique", () => {
    const names = COVEL_ENV_REGISTRY.map((item) => item.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it("keeps enum and secret definitions internally consistent", () => {
    for (const item of COVEL_ENV_REGISTRY) {
      if (item.type === "enum") {
        expect(item.values?.length, `${item.name} enum values`).toBeGreaterThan(
          0,
        );
      }
      if (item.type === "secret") {
        expect(item.secret, `${item.name} secret marker`).toBe(true);
      }
      expect(
        item.description.trim().length,
        `${item.name} description`,
      ).toBeGreaterThan(0);
    }
  });

  it("registers every feature flag name as an active boolean env var", () => {
    for (const flag of COVEL_FEATURE_FLAGS) {
      expect(getEnvDefinition(flag)).toMatchObject({
        name: flag,
        group: expect.any(String),
        type: "boolean",
        status: "active",
      });
    }
  });

  it("looks up definitions by name", () => {
    expect(getEnvDefinition("STORE_BACKEND")?.defaultValue).toBe("sqlite");
    expect(getEnvDefinition("MEDIA_BACKEND")?.defaultValue).toBe("mirror");
    expect(getEnvDefinition("VECTOR_BACKEND")?.defaultValue).toBe("embedded");
    expect(getEnvDefinition("COVEL_LLM_RETRY_DISABLED")?.group).toBe("ai");
  });

  it("parses strict feature flags", () => {
    expect(
      isEnvEnabled("COVEL_LLM_RETRY_DISABLED", {
        COVEL_LLM_RETRY_DISABLED: "1",
      }),
    ).toBe(true);
    expect(
      isEnvEnabled("COVEL_LLM_RETRY_DISABLED", {
        COVEL_LLM_RETRY_DISABLED: "true",
      }),
    ).toBe(false);
    expect(
      isEnvTruthy("ENABLE_DEBUG_PAGE", { ENABLE_DEBUG_PAGE: "true" }),
    ).toBe(true);
  });

  it("normalizes empty strings, integers and csv values", () => {
    const source = {
      EMPTY: "",
      INTEGER_OK: "42",
      INTEGER_BAD: "twelve",
      CSV: " https://a.test, ,https://b.test , ",
    };

    expect(readEnvString("EMPTY", "fallback", source)).toBe("fallback");
    expect(readEnvInt("INTEGER_OK", 7, source)).toBe(42);
    expect(readEnvInt("INTEGER_BAD", 7, source)).toBe(7);
    expect(readEnvCsv("CSV", source)).toEqual([
      "https://a.test",
      "https://b.test",
    ]);
  });

  it("supports default-on env parsing", () => {
    expect(isEnvDefaultOn("ANY_DEFAULT_ON_FLAG", {})).toBe(true);
    expect(
      isEnvDefaultOn("ANY_DEFAULT_ON_FLAG", { ANY_DEFAULT_ON_FLAG: "0" }),
    ).toBe(false);
    expect(
      isEnvDefaultOn("ANY_DEFAULT_ON_FLAG", {
        ANY_DEFAULT_ON_FLAG: "false",
      }),
    ).toBe(false);
  });

  it("reads runtime defaults", () => {
    const env = readRuntimeEnv({});
    expect(env.storeBackend).toBe("sqlite");
    expect(env.sqlitePath).toBe("./data/covel.db");
    expect(env.mediaBackend).toBe("mirror");
    expect(env.vectorBackend).toBe("embedded");
    expect(env.serverPort).toBe(3001);
    // The server must bind loopback unless explicitly opted out.
    expect(env.bindHost).toBe("127.0.0.1");
  });

  it("honors an explicit COVEL_BIND_HOST opt-in (containers/hosted)", () => {
    const env = readRuntimeEnv({ COVEL_BIND_HOST: "0.0.0.0" });
    expect(env.bindHost).toBe("0.0.0.0");
  });

  it("derives the default SQLite path from COVEL_DATA_ROOT when SQLITE_PATH is omitted", () => {
    const env = readRuntimeEnv({
      COVEL_DATA_ROOT: "/home/covel/data",
    });

    expect(env.sqlitePath).toBe("/home/covel/data/covel.db");
  });

  it("reads explicit runtime env values across storage, server, desktop and AI fields", () => {
    const env = readRuntimeEnv({
      STORE_BACKEND: "pg",
      SQLITE_PATH: "/tmp/covel.db",
      DATABASE_URL: "postgresql://user:pass@localhost:5432/covel",
      MEDIA_BACKEND: "pg",
      MEDIA_ROOT: "/srv/media",
      COVEL_MEDIA_TOKEN_SECRET: "media-token-secret",
      VECTOR_BACKEND: "external",
      SERVER_PORT: "18080",
      NODE_ENV: "test",
      SERVE_STATIC: "true",
      STATIC_DIR: "/srv/web",
      DEPLOYMENT_TIER: "demo",
      CORS_ORIGIN: "https://a.test, https://b.test",
      ENABLE_DEBUG_PAGE: "1",
      COVEL_INSTALL_API_ENABLED: "1",
      RATE_LIMIT_RPM: "120",
      TRUSTED_PROXY_IPS: "127.0.0.1,10.0.0.2",
      COVEL_HOME: "/home/covel",
      COVEL_DATA_ROOT: "/home/covel/data",
      COVEL_DESKTOP_REST: "1",
      COVEL_DESKTOP_REST_TOKEN: "rest-token-deadbeef",
      COVEL_LLM_TOML: "/home/covel/llm.toml",
      COVEL_PLUGINS_DIR: "/app/plugins",
      COVEL_USER_PLUGINS_DIR: "/home/covel/plugins",
      COVEL_WORLDS_DIR: "/app/worlds",
      COVEL_USER_WORLDS_DIR: "/home/covel/worlds",
      COVEL_USER_CONFIG_DIR: "/home/covel/config",
      COVEL_LOGS_DIR: "/home/covel/logs",
      COVEL_MODEL_DB_PATH: "/home/covel/model-db.json",
      COVEL_PROMPTS_DIR: "/home/covel/prompts",
      COVEL_COMPACTOR_CONTEXT_WINDOW: "64000",
    });

    expect(env).toMatchObject({
      storeBackend: "pg",
      sqlitePath: "/tmp/covel.db",
      databaseUrl: "postgresql://user:pass@localhost:5432/covel",
      mediaBackend: "pg",
      mediaRoot: "/srv/media",
      mediaTokenSecret: "media-token-secret",
      vectorBackend: "external",
      serverPort: 18080,
      nodeEnv: "test",
      serveStatic: true,
      staticDir: "/srv/web",
      deploymentTier: "demo",
      corsOrigins: ["https://a.test", "https://b.test"],
      debugRoutes: true,
      installApiEnabled: true,
      rateLimitRpm: 120,
      trustedProxyIps: "127.0.0.1,10.0.0.2",
      covelHome: "/home/covel",
      dataRoot: "/home/covel/data",
      desktopRest: true,
      desktopRestToken: "rest-token-deadbeef",
      llmToml: "/home/covel/llm.toml",
      pluginsDir: "/app/plugins",
      userPluginsDir: "/home/covel/plugins",
      worldsDir: "/app/worlds",
      userWorldsDir: "/home/covel/worlds",
      userConfigDir: "/home/covel/config",
      logsDir: "/home/covel/logs",
      modelDbPath: "/home/covel/model-db.json",
      promptsDir: "/home/covel/prompts",
      compactorContextWindow: 64000,
    });
  });

  it("falls back for invalid runtime enum and integer values", () => {
    const env = readRuntimeEnv({
      STORE_BACKEND: "postgres",
      MEDIA_BACKEND: "blobstore",
      VECTOR_BACKEND: "qdrant",
      NODE_ENV: "staging",
      SERVER_PORT: "abc",
      RATE_LIMIT_RPM: "rpm",
      COVEL_COMPACTOR_CONTEXT_WINDOW: "wide",
    });

    expect(env.storeBackend).toBe("sqlite");
    expect(env.mediaBackend).toBe("mirror");
    expect(env.vectorBackend).toBe("embedded");
    expect(env.nodeEnv).toBe("development");
    expect(env.serverPort).toBe(3001);
    expect(env.rateLimitRpm).toBe(60);
    // Invalid → undefined (unset): the compactor then derives the window from
    // the narrative slot's model capability instead of a fixed constant.
    expect(env.compactorContextWindow).toBeUndefined();
  });

  it("lowercase-normalizes DEPLOYMENT_TIER", () => {
    const env = readRuntimeEnv({ DEPLOYMENT_TIER: "COMMERCIAL" });
    expect(env.deploymentTier).toBe("commercial");
  });

  it("rejects an unknown DEPLOYMENT_TIER fail-safe to the most restrictive tier", () => {
    const spy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const env = readRuntimeEnv({ DEPLOYMENT_TIER: "Commercial-typo" });
    expect(env.deploymentTier).toBe("commercial");
    expect(spy).toHaveBeenCalledWith(
      expect.stringContaining("Commercial-typo"),
    );
    spy.mockRestore();
  });

  it("keeps invalid enum values on fallback", () => {
    expect(
      readEnvChoice(
        "STORE_BACKEND",
        ["memory", "sqlite", "pg"] as const,
        "sqlite",
        {
          STORE_BACKEND: "postgres",
        },
      ),
    ).toBe("sqlite");
  });

  it("collects dynamic provider API keys", () => {
    expect(
      providerApiKeysFromEnv({
        DEEPSEEK_API_KEY: "sk-a",
        OPEN_ROUTER_API_KEY: "sk-b",
        OTHER: "x",
      }),
    ).toEqual({
      deepseek: "sk-a",
      "open-router": "sk-b",
    });
  });

  it("maps provider ids back to canonical API key env names", () => {
    expect(providerApiKeyEnvName("open-router")).toBe("OPEN_ROUTER_API_KEY");
    expect(providerApiKeyEnvName("DeepSeek")).toBe("DEEPSEEK_API_KEY");
    expect(providerApiKeyEnvName(" bad provider id ")).toBe(
      "BAD_PROVIDER_ID_API_KEY",
    );
  });
});
