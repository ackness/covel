import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { Hono } from "hono";
import { secureHeaders } from "hono/secure-headers";
import { serveStatic } from "@hono/node-server/serve-static";
import { PLUGIN_FRAME_CSP, PLUGIN_FRAME_PATH } from "@covel/shared";
import { pluginFrameHeaders } from "../../src/middleware/plugin-frame-headers.js";

// The same order as the static block of `app.ts`, over the web app's real
// public directory (the build copies it to the served directory unchanged).
function createApp() {
  const root = fileURLToPath(new URL("../../../web/public", import.meta.url));
  const app = new Hono();
  app.use("*", secureHeaders());
  app.get("/api/thing", (c) => c.json({ ok: true }));
  app.use("/*", pluginFrameHeaders());
  app.use("/*", serveStatic({ root }));
  app.get("*", (c) => c.html("<!doctype html><title>app</title>"));
  return app;
}

describe("plugin frame host response", () => {
  it("serves the frame document itself, sandboxed and closed to the network", async () => {
    const response = await createApp().request(PLUGIN_FRAME_PATH);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/html");
    const body = await response.text();
    expect(body).toContain("covel:connect");
    expect(body).not.toContain("<title>app</title>");

    const policy = response.headers.get("content-security-policy") ?? "";
    const directives = policy.split(";").map((part) => part.trim());
    expect(directives).toEqual([
      ...PLUGIN_FRAME_CSP.split("; "),
      "sandbox allow-scripts",
      "frame-ancestors 'self'",
    ]);
    expect(directives).toContain("default-src 'none'");
    expect(directives).toContain("connect-src 'none'");
    expect(policy).not.toContain("allow-same-origin");
    // The app's own origin frames it; the default of `secureHeaders` allows that.
    expect(response.headers.get("x-frame-options")).toBe("SAMEORIGIN");
  });

  it("takes no plugin, session or file name from the request", async () => {
    const app = createApp();
    const plain = await (await app.request(PLUGIN_FRAME_PATH)).text();
    const withQuery = await app.request(
      `${PLUGIN_FRAME_PATH}?plugin=other&session=s1&file=../../.env`,
    );
    expect(await withQuery.text()).toBe(plain);
    expect(withQuery.headers.get("content-security-policy")).toContain(
      "sandbox allow-scripts",
    );
    expect(plain).not.toMatch(/location\.|searchParams|fetch\(|XMLHttpRequest/);
  });

  it("leaves every other response without the frame policy", async () => {
    const app = createApp();
    for (const path of [
      "/",
      "/session",
      "/icon.png",
      "/api/thing",
      `${PLUGIN_FRAME_PATH}/x`,
      "/plugin-frame.htm",
    ]) {
      const response = await app.request(path);
      expect(response.status, path).toBe(200);
      expect(response.headers.get("content-security-policy"), path).toBeNull();
    }
  });
});
