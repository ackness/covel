import { describe, expect, it } from "vitest";
import { Hono } from "hono";
import { actionRoutes } from "../../src/routes/api/actions.js";
import { pluginRpcRoutes } from "../../src/routes/api/plugin-rpc.js";
import { resumeRoutes } from "../../src/routes/api/resume.js";

const OVERSIZED_HEADER = "a".repeat(8 * 1024 + 1);

async function expectHeaderRejected(
  app: Hono,
  path: string,
  body: unknown,
): Promise<void> {
  const response = await app.request(path, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "X-Plugin-User-Settings": OVERSIZED_HEADER,
    },
    body: JSON.stringify(body),
  });
  expect(response.status).toBe(431);
  await expect(response.json()).resolves.toMatchObject({
    code: "plugin_user_settings_header_too_large",
  });
}

describe("plugin user-settings header early rejection", () => {
  it("rejects actions before the SSE turn pipeline", async () => {
    const app = new Hono();
    app.route("/api/actions", actionRoutes);
    await expectHeaderRejected(app, "/api/actions", {
      requestId: "request-1",
      sessionId: "session-1",
      type: "send_message",
      payload: { content: "hello" },
    });
  });

  it("rejects plugin-rpc before runtime dispatch", async () => {
    const app = new Hono();
    app.route("/api/sessions", pluginRpcRoutes);
    await expectHeaderRejected(app, "/api/sessions/session-1/plugin-rpc", {
      kind: "runtime",
      pluginId: "plugin-1",
      runtimeId: "plugin-1/runtime",
    });
  });

  it("rejects resume before a suspension claim or hook scope", async () => {
    const app = new Hono();
    app.route("/api/sessions", resumeRoutes);
    await expectHeaderRejected(
      app,
      "/api/sessions/session-1/suspensions/suspension-1/resume",
      { data: {} },
    );
  });
});
