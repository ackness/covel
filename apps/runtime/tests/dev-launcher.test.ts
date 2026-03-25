import { describe, expect, it } from "vitest";

import {
  createDevCommandSpecs,
  resolveAvailableDevEnvironmentConfig,
  resolveDevEnvironmentConfig
} from "../../../scripts/dev.ts";

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
});
