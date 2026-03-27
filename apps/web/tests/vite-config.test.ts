import { describe, expect, it } from "vitest";

import { createRuntimeProxyConfig, resolveRuntimeProxyTarget } from "../vite.config.js";

describe("apps/web vite config", () => {
  it("proxies runtime API routes to the local runtime server during development", () => {
    expect(createRuntimeProxyConfig()).toMatchObject({
      "/actions": {
        target: "http://127.0.0.1:8787"
      },
      "/archives": {
        target: "http://127.0.0.1:8787"
      },
      "/commands": {
        target: "http://127.0.0.1:8787"
      },
      "/packages": {
        target: "http://127.0.0.1:8787"
      },
      "/presets": {
        target: "http://127.0.0.1:8787"
      },
      "/sessions": {
        target: "http://127.0.0.1:8787"
      },
      "/traces": {
        target: "http://127.0.0.1:8787"
      },
      "/worlds": {
        target: "http://127.0.0.1:8787"
      }
    });
  });

  it("allows overriding the proxied runtime target through environment variables", () => {
    expect(resolveRuntimeProxyTarget({
      RUNTIME_HOST: "0.0.0.0",
      RUNTIME_PORT: "8788"
    })).toBe("http://0.0.0.0:8788");
  });
});
