import { describe, expect, it } from "vitest";

import {
  createArchiveVersion,
  createArtifact,
  createJobRecord,
  createMemoryDocument,
  createMessage,
  createPackageStateRecord,
  createRetrievalRun,
  createSession,
  createTraceRecord,
  createWorld
} from "../../domain/src/index.js";
import { createInMemoryStorageRepositories } from "../src/index.js";

describe("createInMemoryStorageRepositories", () => {
  it("conforms to the domain repository ports", async () => {
    const repositories = createInMemoryStorageRepositories();

    const world = createWorld({
      id: "world-1",
      name: "Northreach",
      description: "Frozen frontier world",
      createdAt: new Date("2026-01-01T00:00:00.000Z")
    });
    const session = createSession({
      id: "session-1",
      worldId: world.id,
      status: "active",
      createdAt: new Date("2026-01-01T00:00:01.000Z")
    });
    const firstMessage = createMessage({
      id: "message-1",
      sessionId: session.id,
      role: "user",
      content: "look around",
      createdAt: new Date("2026-01-01T00:00:02.000Z")
    });
    const secondMessage = createMessage({
      id: "message-2",
      sessionId: session.id,
      role: "assistant",
      content: "You stand in a snowed-in courtyard.",
      createdAt: new Date("2026-01-01T00:00:03.000Z")
    });
    const artifact = createArtifact({
      id: "artifact-1",
      sessionId: session.id,
      kind: "image",
      uri: "sessions/session-1/artifacts/artifact-1/map.png",
      mediaType: "image/png",
      createdAt: new Date("2026-01-01T00:00:04.000Z")
    });
    const archiveVersion = createArchiveVersion({
      id: "archive-1",
      sessionId: session.id,
      turnCutoff: 2,
      stateSnapshot: { hp: 10 },
      workingSummary: "The player entered the ruins.",
      archiveSummary: "Act 1 recap",
      createdAt: new Date("2026-01-01T00:00:05.000Z")
    });
    const memoryDocument = createMemoryDocument({
      id: "memory-1",
      sourceType: "world",
      scope: `world:${world.id}`,
      title: "World overview",
      content: "Northreach is a frontier kingdom.",
      metadata: { tags: ["world"] },
      provenance: { sourceId: world.id }
    });
    const retrievalRun = createRetrievalRun({
      id: "retrieval-1",
      sessionId: session.id,
      query: "Where is the observatory key?",
      rewrittenQueries: ["observatory key location"],
      selectedSources: ["world", "archive"],
      candidates: ["chunk-1", "chunk-2"],
      selectedChunks: ["chunk-2"],
      critique: "Enough evidence to answer.",
      latencyMs: 12
    });
    const traceRecord = createTraceRecord({
      traceId: "trace-1",
      spanId: "span-1",
      sessionId: session.id,
      turnId: "turn-1",
      component: "turn-flow",
      eventType: "model.completed",
      payload: { tokens: 120 },
      createdAt: new Date("2026-01-01T00:00:06.000Z")
    });

    await repositories.worlds.save(world);
    await repositories.sessions.save(session);
    await repositories.messages.save(secondMessage);
    await repositories.messages.save(firstMessage);
    await repositories.artifacts.save(artifact);
    await repositories.archiveVersions.save(archiveVersion);
    await repositories.memoryDocuments.save(memoryDocument);
    await repositories.retrievalRuns.save(retrievalRun);
    await repositories.traceRecords.save(traceRecord);

    await expect(repositories.worlds.getById(world.id)).resolves.toEqual(world);
    await expect(repositories.worlds.list()).resolves.toEqual([world]);
    await expect(repositories.sessions.getById(session.id)).resolves.toEqual(session);
    await expect(repositories.sessions.listByWorldId(world.id)).resolves.toEqual([session]);
    await expect(repositories.messages.listBySessionId(session.id)).resolves.toEqual([
      firstMessage,
      secondMessage
    ]);
    await expect(repositories.artifacts.listBySessionId(session.id)).resolves.toEqual([artifact]);
    await expect(repositories.archiveVersions.getById(archiveVersion.id)).resolves.toEqual(
      archiveVersion
    );
    await expect(repositories.archiveVersions.listBySessionId(session.id)).resolves.toEqual([
      archiveVersion
    ]);
    await expect(repositories.memoryDocuments.getById(memoryDocument.id)).resolves.toEqual(
      memoryDocument
    );
    await expect(repositories.memoryDocuments.listByScope(memoryDocument.scope)).resolves.toEqual([
      memoryDocument
    ]);
    await expect(repositories.retrievalRuns.listBySessionId(session.id)).resolves.toEqual([
      retrievalRun
    ]);
    await expect(repositories.traceRecords.listByTraceId(traceRecord.traceId)).resolves.toEqual([
      traceRecord
    ]);
  });

  it("stores package state, jobs, and richer pending blocks", async () => {
    const repositories = createInMemoryStorageRepositories();

    const packageState = createPackageStateRecord({
      scope: "session",
      ownerId: "session-1",
      packageName: "director-choices",
      collection: "choice_state",
      key: "turn-1",
      value: {
        selected: "opt_a"
      },
      updatedAt: new Date("2026-01-01T00:00:10.000Z")
    });
    const job = createJobRecord({
      id: "job-1",
      packageName: "story-image",
      jobType: "scene-image",
      sessionId: "session-1",
      status: "queued",
      input: {
        scene: "Northreach"
      },
      attempt: 0,
      createdAt: new Date("2026-01-01T00:00:11.000Z")
    });

    await repositories.packageState.save(packageState);
    await repositories.jobs.save(job);
    await repositories.pendingBlocks.save({
      blockId: "blk_01",
      sessionId: "session-1",
      flowId: "flow-1",
      turnId: "turn-1",
      packageName: "director-choices",
      resumeHandler: "director.resumeChoice",
      blockEnvelope: {
        id: "blk_01",
        type: "choice_set"
      }
    });

    await expect(repositories.packageState.get({
      scope: "session",
      ownerId: "session-1",
      packageName: "director-choices",
      collection: "choice_state",
      key: "turn-1"
    })).resolves.toEqual(packageState);
    await expect(repositories.jobs.getById("job-1")).resolves.toEqual(job);
    await expect(repositories.jobs.listByStatus("queued")).resolves.toEqual([job]);
    await expect(repositories.pendingBlocks.getByBlockId("blk_01")).resolves.toEqual({
      blockId: "blk_01",
      sessionId: "session-1",
      flowId: "flow-1",
      turnId: "turn-1",
      packageName: "director-choices",
      resumeHandler: "director.resumeChoice",
      blockEnvelope: {
        id: "blk_01",
        type: "choice_set"
      }
    });
  });
});
