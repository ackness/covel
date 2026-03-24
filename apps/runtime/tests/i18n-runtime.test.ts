import { once } from "node:events";

import { afterEach, describe, expect, it } from "vitest";

import { ActionRequestSchema, type SseEnvelope } from "../../../modules/contracts/src/index.js";
import { createRuntimeServer } from "../src/index.js";

async function listen(server: ReturnType<typeof createRuntimeServer>): Promise<string> {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("Failed to resolve listening address.");
  }

  return `http://127.0.0.1:${address.port}`;
}

function createSseEvent(): SseEnvelope {
  return {
    type: "flow.completed",
    requestId: "req_01",
    traceId: "tr_01",
    sessionId: "session_01",
    turnId: "turn_01",
    flowId: "flow_01",
    seq: 1,
    timestamp: "2026-03-24T12:00:00.000Z",
    payload: {
      turnId: "turn_01"
    }
  };
}

describe("createRuntimeServer i18n", () => {
  const servers = new Set<ReturnType<typeof createRuntimeServer>>();

  afterEach(async () => {
    await Promise.all(
      Array.from(servers).map(
        (server) =>
          new Promise<void>((resolve, reject) => {
            server.close((error) => {
              if (error) {
                reject(error);
                return;
              }
              resolve();
            });
          })
      )
    );
    servers.clear();
  });

  it("defaults action locale to zh-CN", async () => {
    let capturedAction: ReturnType<typeof ActionRequestSchema.parse> | null = null;
    const server = createRuntimeServer({
      flowEngine: {
        async handle(action) {
          capturedAction = action;
          return [createSseEvent()];
        }
      }
    });
    servers.add(server);
    const baseUrl = await listen(server);

    await fetch(`${baseUrl}/actions`, {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify({
        requestId: "req_01",
        type: "send_message",
        sessionId: "session_01",
        payload: {
          content: "继续前进"
        }
      })
    });

    expect(capturedAction).toMatchObject({
      locale: "zh-CN"
    });
  });

  it("resolves English from Accept-Language and localizes invalid request errors", async () => {
    const server = createRuntimeServer({
      flowEngine: {
        async handle() {
          return [createSseEvent()];
        }
      }
    });
    servers.add(server);
    const baseUrl = await listen(server);

    const response = await fetch(`${baseUrl}/actions`, {
      method: "POST",
      headers: {
        "accept-language": "en-US,en;q=0.9",
        "content-type": "application/json"
      },
      body: JSON.stringify({
        type: "send_message"
      })
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: {
        code: "INVALID_REQUEST",
        message: "Invalid request."
      }
    });
  });
});
