import { execFile } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { validatePluginRpcBody } from "../../src/routes/api/plugin-rpc/body.js";

const executeFile = promisify(execFile);
const script = fileURLToPath(
  new URL("../../../../scripts/e2e-plugin-verify.ts", import.meta.url),
);

describe("e2e plugin verification CLI HTTP contract", () => {
  it("enables plugins, submits a form, and reads the current session view", async () => {
    const requests: Array<{ method: string; path: string; body: unknown }> = [];
    const fixtureErrors: unknown[] = [];
    let actionCount = 0;
    const session = {
      id: "contract-session",
      status: "active",
      phase: "playing",
      completedPlayerTurns: 0,
      setupRuntimes: {},
      activePlugins: ["contract-plugin"],
    };
    const server = createServer(async (req, res) => {
      try {
        let rawBody = "";
        for await (const chunk of req) rawBody += String(chunk);
        const body: unknown = rawBody ? JSON.parse(rawBody) : undefined;
        const method = req.method ?? "GET";
        const path = req.url ?? "/";
        requests.push({ method, path, body });
        const json = (value: unknown, status = 200) => {
          res.writeHead(status, { "content-type": "application/json" });
          res.end(JSON.stringify(value));
        };

        switch (`${method} ${path}`) {
          case "GET /api/health":
            return json({ status: "ok", bootId: "contract-boot" });
          case "GET /api/plugin-flows":
            return json({ version: "1", plugins: [], steps: [], segments: [] });
          case "GET /api/worlds":
            return json({ items: [{ id: "contract-world" }] });
          case "POST /api/sessions":
            return json(session, 201);
          case "PUT /api/sessions/contract-session/plugins/contract-plugin":
            return json({ ok: true, activePluginIds: session.activePlugins });
          case "GET /api/sessions/contract-session":
            return json(session);
          case "POST /api/actions":
            actionCount += 1;
            res.writeHead(200, { "content-type": "text/event-stream" });
            res.end('data: {"type":"execution.completed","payload":{}}\n\n');
            return;
          case "GET /api/sessions/contract-session/turns":
            return json({
              items: [
                {
                  turnId: `contract-turn-${actionCount}`,
                  sessionId: session.id,
                  durationMs: 1,
                  runtimeResults: [
                    {
                      runtimeId: "contract-plugin/setup",
                      pluginId: "contract-plugin",
                      status: "success",
                      durationMs: 1,
                      output:
                        actionCount === 1
                          ? {
                              interactions: [
                                {
                                  type: "form",
                                  interactionId: "contract-form",
                                  fields: [
                                    { name: "characterName", type: "text" },
                                  ],
                                },
                              ],
                            }
                          : {},
                    },
                  ],
                },
              ],
            });
          case "POST /api/sessions/contract-session/plugin-rpc": {
            const parsed = validatePluginRpcBody(body);
            if (!parsed.ok) return json({ error: parsed.error }, 400);
            return json({ status: "ok", result: {} });
          }
          case "GET /api/sessions/contract-session/view":
            return json({
              session: { id: session.id },
              messages: [],
              characters: [],
              plugins: [{ id: "contract-plugin", active: true }],
            });
          case "GET /api/traces/contract-session":
            return json({
              events: [
                "turn.started",
                "runtime.started",
                "runtime.completed",
              ].map((type, eventOrder) => ({ type, eventOrder, payload: {} })),
            });
          case "DELETE /api/sessions/contract-session":
            return json({ ok: true });
          default:
            return json(
              { error: `Unexpected request: ${method} ${path}` },
              404,
            );
        }
      } catch (error) {
        fixtureErrors.push(error);
        res.writeHead(500);
        res.end();
      }
    });

    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string")
      throw new Error("No fixture port");
    try {
      // Native TypeScript support follows the repository's Node 26 requirement.
      // An empty environment prevents inheriting provider keys or local config.
      const { stdout } = await executeFile(
        process.execPath,
        [
          script,
          "--server",
          `http://127.0.0.1:${address.port}/api`,
          "--no-log",
          "--turns",
          "0",
          "--enable-plugins",
          "contract-plugin",
          "--form-values",
          '{"characterName":"Contract Player"}',
          "--timeout",
          "2",
        ],
        { env: {}, timeout: 10_000 },
      );

      expect(fixtureErrors).toEqual([]);
      expect(actionCount).toBe(2);
      expect(requests).toContainEqual({
        method: "PUT",
        path: "/api/sessions/contract-session/plugins/contract-plugin",
        body: undefined,
      });
      expect(requests).toContainEqual({
        method: "POST",
        path: "/api/sessions/contract-session/plugin-rpc",
        body: {
          kind: "action",
          pluginId: "framework",
          action: "submit-form",
          payload: {
            turnId: "contract-turn-1",
            submissions: [
              {
                interactionId: "contract-form",
                type: "form",
                values: { characterName: "Contract Player" },
              },
            ],
          },
        },
      });
      expect(requests).toContainEqual({
        method: "GET",
        path: "/api/sessions/contract-session/view",
        body: undefined,
      });
      expect(stdout).toMatch(/Active plugins\s*: 1\b/u);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  }, 15_000);
});
