import { once } from "node:events";

import { afterEach, describe, expect, it } from "vitest";

import type { SseEnvelope, WorkflowSnapshotRecord } from "../../../modules/contracts/src/index.js";
import { createArchiveService, createInMemoryArchiveLineageStore, createInMemoryReindexMarkStore } from "../../../modules/archive/src/index.js";
import { createArtifact, createMessage, createPackageStateRecord, createSession, createWorld } from "../../../modules/domain/src/index.js";
import { createInMemoryStorageRepositories } from "../../../modules/storage/src/index.js";
import { createRuntimeServer } from "../src/index.js";

function createSseEvent(type: string, seq: number): SseEnvelope {
  return {
    type,
    requestId: "req_01",
    traceId: "tr_01",
    sessionId: "ses_01",
    turnId: "turn_01",
    flowId: "flow_01",
    seq,
    timestamp: "2026-03-24T12:00:00.000Z",
    payload: {}
  };
}

async function listen(server: ReturnType<typeof createRuntimeServer>): Promise<string> {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("Failed to resolve listening address.");
  }
  return `http://127.0.0.1:${address.port}`;
}

describe("createRuntimeServer", () => {
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

  it("streams flow-engine events as HTTP action + SSE", async () => {
    let capturedLocale: string | undefined;
    const server = createRuntimeServer({
      flowEngine: {
        async handle(action) {
          capturedLocale = action.locale;
          return [
            createSseEvent("message.delta", 1),
            createSseEvent("message.completed", 2),
            createSseEvent("flow.completed", 3)
          ];
        }
      }
    });
    servers.add(server);
    const baseUrl = await listen(server);

    const response = await fetch(`${baseUrl}/actions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "accept-language": "en-US,en;q=0.9"
      },
      body: JSON.stringify({
        requestId: "req_01",
        type: "send_message",
        sessionId: "ses_01",
        payload: {
          content: "继续前进"
        }
      })
    });

    const body = await response.text();

    expect(response.status).toBe(200);
    expect(capturedLocale).toBe("en");
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    expect(body).toContain("event: message.delta");
    expect(body).toContain("event: message.completed");
    expect(body).toContain("event: flow.completed");
  });

  it("returns 400 for invalid action payloads", async () => {
    const server = createRuntimeServer({
      flowEngine: {
        async handle() {
          return [];
        }
      }
    });
    servers.add(server);
    const baseUrl = await listen(server);

    const response = await fetch(`${baseUrl}/actions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "accept-language": "en-US,en;q=0.9"
      },
      body: JSON.stringify({
        type: "send_message"
      })
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: {
        code: "INVALID_REQUEST",
        message: "Invalid request."
      }
    });
  });

  it("returns 413 when a request body exceeds the configured size limit", async () => {
    const server = createRuntimeServer({
      flowEngine: {
        async handle() {
          return [];
        }
      },
      maxRequestBodyBytes: 32
    });
    servers.add(server);
    const baseUrl = await listen(server);

    const response = await fetch(`${baseUrl}/actions`, {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify({
        requestId: "req_oversized",
        type: "send_message",
        sessionId: "ses_01",
        payload: {
          content: "This payload should exceed the tiny request body limit."
        }
      })
    });

    expect(response.status).toBe(413);
    await expect(response.json()).resolves.toMatchObject({
      error: {
        code: "PAYLOAD_TOO_LARGE"
      }
    });
  });

  it("defaults runtime errors to Chinese when no locale is provided", async () => {
    const server = createRuntimeServer({
      flowEngine: {
        async handle() {
          return [];
        }
      }
    });
    servers.add(server);
    const baseUrl = await listen(server);

    const response = await fetch(`${baseUrl}/missing`);

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({
      error: {
        code: "NOT_FOUND",
        message: "资源不存在。"
      }
    });
  });

  it("exposes merged command help and autocomplete metadata through /commands", async () => {
    const server = createRuntimeServer({
      flowEngine: {
        async handle() {
          return [];
        }
      },
      commandRegistry: {
        listHelp() {
          return [
            {
              name: "world-seeds",
              description: "Inspect staged world seed content.",
              usage: "/world-seeds [seedId]",
              examples: ["/world-seeds", "/world-seeds --seed legacy-wuxia-nine-provinces"]
            }
          ];
        },
        listAutocomplete() {
          return [
            {
              name: "world-seeds",
              positionalHints: ["seedId"],
              flagHints: [
                {
                  name: "--seed",
                  description: "Inspect a staged world seed by id.",
                  takesValue: true
                }
              ]
            }
          ];
        }
      }
    });
    servers.add(server);
    const baseUrl = await listen(server);

    const response = await fetch(`${baseUrl}/commands`);
    const body = await response.json() as Array<{
      name: string;
      description: string;
      usage: string;
      examples?: string[];
      positionalHints?: string[];
      flagHints?: Array<{
        name: string;
        description: string;
        takesValue: boolean;
      }>;
    }>;

    expect(response.status).toBe(200);
    expect(body).toEqual([
      {
        name: "world-seeds",
        description: "Inspect staged world seed content.",
        usage: "/world-seeds [seedId]",
        examples: ["/world-seeds", "/world-seeds --seed legacy-wuxia-nine-provinces"],
        positionalHints: ["seedId"],
        flagHints: [
          {
            name: "--seed",
            description: "Inspect a staged world seed by id.",
            takesValue: true
          }
        ]
      }
    ]);
  });

  it("creates and lists worlds and sessions through the runtime host", async () => {
    const repositories = createInMemoryStorageRepositories();
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

    const worldResponse = await fetch(`${baseUrl}/worlds`, {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify({
        name: "Northreach",
        description: "Frozen frontier"
      })
    });
    const world = await worldResponse.json() as {
      id: string;
      name: string;
      description: string;
      createdAt: string;
    };

    const sessionResponse = await fetch(`${baseUrl}/sessions`, {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify({
        worldId: world.id
      })
    });
    const session = await sessionResponse.json() as {
      id: string;
      worldId: string;
      status: string;
      createdAt: string;
    };

    const worldsResponse = await fetch(`${baseUrl}/worlds`);
    const worlds = await worldsResponse.json() as Array<{
      id: string;
      name: string;
      description: string;
      createdAt: string;
    }>;

    expect(worldResponse.status).toBe(201);
    expect(sessionResponse.status).toBe(201);
    expect(world.id).toBe("world_01");
    expect(session.id).toBe("session_01");
    expect(worlds).toEqual([world]);
  });

  it("lists sessions, messages, packages, and archive operations through the runtime host", async () => {
    const repositories = createInMemoryStorageRepositories();
    const archiveService = createArchiveService({
      repositories,
      lineageStore: createInMemoryArchiveLineageStore(),
      reindexMarkStore: createInMemoryReindexMarkStore(),
      now() {
        return new Date("2026-03-24T12:00:00.000Z");
      },
      createId(kind) {
        if (kind === "archive-version") return "archive_01";
        if (kind === "archive-lineage") return "lineage_01";
        if (kind === "session") return "session_02";
        return `${kind}_01`;
      }
    });

    const world = createWorld({
      id: "world_01",
      name: "Northreach",
      description: "Frozen frontier",
      createdAt: new Date("2026-03-24T12:00:00.000Z")
    });
    const session = createSession({
      id: "session_01",
      worldId: world.id,
      status: "active",
      createdAt: new Date("2026-03-24T12:00:01.000Z")
    });
    const userMessage = createMessage({
      id: "msg_01",
      sessionId: session.id,
      role: "user",
      content: "Open the gate",
      createdAt: new Date("2026-03-24T12:00:02.000Z")
    });
    const assistantMessage = createMessage({
      id: "msg_02",
      sessionId: session.id,
      role: "assistant",
      content: "The gate opens.",
      createdAt: new Date("2026-03-24T12:00:03.000Z")
    });
    const artifact = createArtifact({
      id: "artifact_01",
      sessionId: session.id,
      kind: "image",
      uri: "sessions/session_01/artifacts/artifact_01/map.png",
      mediaType: "image/png",
      createdAt: new Date("2026-03-24T12:00:04.000Z")
    });

    await repositories.worlds.save(world);
    await repositories.sessions.save(session);
    await repositories.messages.save(userMessage);
    await repositories.messages.save(assistantMessage);
    await repositories.artifacts.save(artifact);

    const server = createRuntimeServer({
      flowEngine: {
        async handle() {
          return [];
        }
      },
      repositories,
      packageRuntime: {
        listPackages() {
          return [
            {
              name: "core-guide",
              rootDir: "/tmp/core-guide",
              manifest: {
                schemaVersion: "1.0",
                name: "core-guide",
                version: "0.1.0",
                description: "Guide",
                scopes: ["world", "session"],
                permissions: ["emit:block"],
                modelPolicy: {
                  preferredTier: "small"
                },
                contributes: {
                  context: [],
                  commands: [],
                  blocks: [],
                  renderers: []
                }
              },
              enabled: true,
              skillMarkdown: "# guide"
            }
          ];
        }
      },
      archiveService,
      createId(kind) {
        return `${kind}_01`;
      },
      now() {
        return new Date("2026-03-24T12:00:00.000Z");
      }
    });
    servers.add(server);
    const baseUrl = await listen(server);

    const sessionsResponse = await fetch(`${baseUrl}/sessions?worldId=${world.id}`);
    const sessions = await sessionsResponse.json() as Array<{ id: string }>;

    const messagesResponse = await fetch(`${baseUrl}/sessions/${session.id}/messages`);
    const messages = await messagesResponse.json() as Array<{ id: string }>;

    const packageState = createPackageStateRecord({
      scope: "session",
      ownerId: session.id,
      packageName: "core-guide",
      collection: "quest_state",
      key: "quest-01",
      value: {
        stage: "started"
      },
      updatedAt: new Date("2026-03-24T12:00:05.000Z")
    });
    await repositories.packageState.save(packageState);
    const workflowSnapshot: WorkflowSnapshotRecord = {
      runId: "flow_01",
      stepId: "turn_01",
      sessionId: session.id,
      status: "suspended",
      suspendPayload: {
        blockId: "blk_01"
      },
      updatedAt: "2026-03-24T12:00:06.000Z"
    };
    await repositories.workflowSnapshots.save(workflowSnapshot);

    const packageStateResponse = await fetch(
      `${baseUrl}/sessions/${session.id}/package-state?packageName=core-guide&collection=quest_state`
    );
    const packageStateRecords = await packageStateResponse.json() as Array<{ key: string }>;

    const workflowResponse = await fetch(`${baseUrl}/sessions/${session.id}/workflow-snapshots`);
    const workflowSnapshots = await workflowResponse.json() as Array<{ runId: string; status: string }>;

    const packagesResponse = await fetch(`${baseUrl}/packages`);
    const packages = await packagesResponse.json() as Array<{ name: string; enabled: boolean }>;

    const archiveCreateResponse = await fetch(`${baseUrl}/archives`, {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify({
        sessionId: session.id,
        turnCutoff: 2,
        stateSnapshot: {
          scene: "gatehouse"
        },
        workingSummary: "The scout reached the gatehouse.",
        archiveSummary: "Act 1 summary"
      })
    });
    const archive = await archiveCreateResponse.json() as { version: { id: string } };

    const archivesResponse = await fetch(`${baseUrl}/archives?sessionId=${session.id}`);
    const archives = await archivesResponse.json() as Array<{ id: string }>;

    const restoreResponse = await fetch(`${baseUrl}/archives/${archive.version.id}/restore`, {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify({
        mode: "restore-as-fork"
      })
    });
    const restored = await restoreResponse.json() as { session: { id: string } };

    expect(sessionsResponse.status).toBe(200);
    expect(sessions.map((item) => item.id)).toEqual([session.id]);
    expect(messages.map((item) => item.id)).toEqual([userMessage.id, assistantMessage.id]);
    expect(packageStateRecords.map((item) => item.key)).toEqual(["quest-01"]);
    expect(workflowSnapshots).toEqual([
      expect.objectContaining({
        runId: "flow_01",
        status: "suspended"
      })
    ]);
    expect(packages).toEqual([
      {
        name: "core-guide",
        enabled: true
      }
    ]);
    expect(archiveCreateResponse.status).toBe(201);
    expect(archives.map((item) => item.id)).toEqual(["archive_01"]);
    expect(restoreResponse.status).toBe(200);
    expect(restored.session.id).toBe("session_02");
  });
});
