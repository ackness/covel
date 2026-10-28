// @vitest-environment node
import { describe, expect, it } from "vitest";
import { Hono } from "hono";
import {
  LOCAL_MODEL_RELAY_CONNECT_SOURCES,
  PAGE_CONNECT_SOURCES,
  PLUGIN_FRAME_CSP,
} from "@covel/shared";
import { localModelRelayPagePolicy } from "../../src/middleware/page-relay-policy.js";

const PAGE = `<html><head><meta http-equiv="Content-Security-Policy" content="default-src 'self'; connect-src ${PAGE_CONNECT_SOURCES}; frame-src 'self'"></head></html>`;
const FRAME = `<html><head><meta http-equiv="Content-Security-Policy" content="${PLUGIN_FRAME_CSP}"></head></html>`;

function appFor(enabled: boolean) {
  const app = new Hono();
  app.use("/*", localModelRelayPagePolicy(enabled));
  app.get("/", (c) => c.html(PAGE));
  app.get("/plugin-frame.html", (c) => c.html(FRAME));
  app.get("/app.js", (c) =>
    c.body("console.log(1)", 200, { "content-type": "text/javascript" }),
  );
  return app;
}

describe("localModelRelayPagePolicy", () => {
  it("adds this computer's http to the page a shared host serves", async () => {
    const page = await (await appFor(true).request("/")).text();
    expect(page).toContain(
      `connect-src ${PAGE_CONNECT_SOURCES} ${LOCAL_MODEL_RELAY_CONNECT_SOURCES};`,
    );
    expect(
      await (await appFor(true).request("/plugin-frame.html")).text(),
    ).toBe(FRAME);
    expect(await (await appFor(true).request("/app.js")).text()).toBe(
      "console.log(1)",
    );
  });

  it("leaves the page alone on a personal host and the desktop app", async () => {
    expect(await (await appFor(false).request("/")).text()).toBe(PAGE);
  });
});
