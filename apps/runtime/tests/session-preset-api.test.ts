import { once } from "node:events";

import { afterEach, describe, expect, it } from "vitest";

import { createInMemoryStorageRepositories } from "../../../modules/storage/src/index.js";
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

describe("runtime session task binding API", () => {
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

  it("creates a session with optional taskBindings and lets them be updated later", async () => {
    const repositories = createInMemoryStorageRepositories();
    await repositories.worlds.save({
      id: "world_01",
      name: "Northreach",
      description: "Frozen frontier",
      createdAt: new Date("2026-03-24T12:00:00.000Z")
    });
    const server = createRuntimeServer({
      flowEngine: {
        async handle() {
          return [];
        }
      },
      repositories,
      createId(kind) {
        return `${kind}_01`;
      },
      now() {
        return new Date("2026-03-24T12:00:00.000Z");
      }
    });
    servers.add(server);

    const baseUrl = await listen(server);
    const createResponse = await fetch(`${baseUrl}/sessions`, {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify({
        worldId: "world_01",
        taskBindings: {
          "story.narration": "story-default"
        }
      })
    });
    const created = await createResponse.json() as {
      id: string;
      worldId: string;
      status: string;
      taskBindings?: Record<string, string>;
      createdAt: string;
    };

    const patchResponse = await fetch(`${baseUrl}/sessions/${created.id}`, {
      method: "PATCH",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify({
        taskBindings: {
          "story.narration": "fallback-free",
          "story.choice-generation": "choice-fast"
        }
      })
    });
    const updated = await patchResponse.json() as {
      id: string;
      worldId: string;
      status: string;
      taskBindings?: Record<string, string>;
      createdAt: string;
    };

    expect(createResponse.status).toBe(201);
    expect(created).toMatchObject({
      id: "session_01",
      worldId: "world_01",
      taskBindings: {
        "story.narration": "story-default"
      }
    });
    expect(patchResponse.status).toBe(200);
    expect(updated).toMatchObject({
      id: "session_01",
      taskBindings: {
        "story.narration": "fallback-free",
        "story.choice-generation": "choice-fast"
      }
    });
    await expect(repositories.sessions.getById("session_01")).resolves.toMatchObject({
      taskBindings: {
        "story.narration": "fallback-free",
        "story.choice-generation": "choice-fast"
      }
    });
  });
});
