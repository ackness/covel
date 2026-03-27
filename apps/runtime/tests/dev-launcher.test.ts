import { describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import process from "node:process";

import {
  createDevCommandSpecs,
  prepareRuntimeEnvironment,
  resolveAvailableDevEnvironmentConfig,
  resolveDevEnvironmentConfig
} from "../../../scripts/dev.js";

describe("dev environment launcher", () => {
  it("uses local web and runtime defaults", () => {
    expect(resolveDevEnvironmentConfig({})).toEqual({
      runtimeHost: "127.0.0.1",
      runtimePort: "8787",
      webPort: "5173"
    });
  });

  it("builds aligned runtime and web commands from environment overrides", () => {
    expect(createDevCommandSpecs({
      RUNTIME_HOST: "0.0.0.0",
      RUNTIME_PORT: "8788",
      WEB_PORT: "5174"
    })).toEqual([
      expect.objectContaining({
        name: "runtime",
        args: ["start:runtime"],
        env: expect.objectContaining({
          HOST: "0.0.0.0",
          PORT: "8788"
        })
      }),
      expect.objectContaining({
        name: "web",
        args: ["exec", "vite", "--config", "apps/web/vite.config.ts", "--port", "5174"],
        env: expect.objectContaining({
          RUNTIME_HOST: "0.0.0.0",
          RUNTIME_PORT: "8788"
        })
      })
    ]);
  });

  it("falls back to the next runtime port when the default one is busy", async () => {
    await expect(resolveAvailableDevEnvironmentConfig({}, async (host, port) => {
      expect(host).toBe("127.0.0.1");
      return port !== 8787;
    })).resolves.toEqual({
      runtimeHost: "127.0.0.1",
      runtimePort: "8788",
      webPort: "5173"
    });
  });

  it("loads provider env from the local .env file when bootstrapping the runtime", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "covel-dev-env-"));
    const previousApiKey = process.env.LIVE_LLM_PRIMARY_API_KEY;
    const previousBaseUrl = process.env.LIVE_LLM_PRIMARY_BASE_URL;
    const previousDatabaseUrl = process.env.DATABASE_URL;

    try {
      delete process.env.LIVE_LLM_PRIMARY_API_KEY;
      delete process.env.LIVE_LLM_PRIMARY_BASE_URL;
      delete process.env.DATABASE_URL;

      await writeFile(
        join(tempRoot, ".env"),
        [
          "LIVE_LLM_PRIMARY_API_KEY=test-live-key",
          "LIVE_LLM_PRIMARY_BASE_URL=https://example.test/v1",
          "DATABASE_URL=postgres://from-env-file.invalid/covel",
          ""
        ].join("\n"),
        "utf8"
      );

      const runtimeEnv = prepareRuntimeEnvironment(process.env, tempRoot);

      expect(runtimeEnv).toBe(process.env);
      expect(process.env.LIVE_LLM_PRIMARY_API_KEY).toBe("test-live-key");
      expect(process.env.LIVE_LLM_PRIMARY_BASE_URL).toBe("https://example.test/v1");
      expect(process.env.DATABASE_URL).toBeUndefined();
    } finally {
      if (previousApiKey === undefined) {
        delete process.env.LIVE_LLM_PRIMARY_API_KEY;
      } else {
        process.env.LIVE_LLM_PRIMARY_API_KEY = previousApiKey;
      }

      if (previousBaseUrl === undefined) {
        delete process.env.LIVE_LLM_PRIMARY_BASE_URL;
      } else {
        process.env.LIVE_LLM_PRIMARY_BASE_URL = previousBaseUrl;
      }

      if (previousDatabaseUrl === undefined) {
        delete process.env.DATABASE_URL;
      } else {
        process.env.DATABASE_URL = previousDatabaseUrl;
      }

      await rm(tempRoot, { recursive: true, force: true });
    }
  });
});
