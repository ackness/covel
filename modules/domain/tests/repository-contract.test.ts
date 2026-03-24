import { describe, expect, it } from "vitest";

import {
  createArchiveVersion,
  createArtifact,
  createMemoryDocument,
  createMessage,
  createRetrievalRun,
  createSession,
  createTraceRecord,
  createWorld
} from "../src/index.js";
import { createRepositoryFixture } from "./fixtures/repository-fixture.js";

describe("repository port contracts", () => {
  it("WorldRepository persists and loads by id", async () => {
    const repositories = createRepositoryFixture();
    const world = createWorld({
      id: "world-1",
      name: "Northreach",
      description: "Frozen frontier world",
      createdAt: new Date("2026-01-01T00:00:00.000Z")
    });

    await repositories.worlds.save(world);

    await expect(repositories.worlds.getById(world.id)).resolves.toEqual(world);
  });

  it("SessionRepository scopes sessions by world id", async () => {
    const repositories = createRepositoryFixture();
    const session = createSession({
      id: "session-1",
      worldId: "world-1",
      status: "active",
      createdAt: new Date("2026-01-01T00:00:00.000Z")
    });

    await repositories.sessions.save(session);

    await expect(repositories.sessions.listByWorldId(session.worldId)).resolves.toEqual([session]);
  });

  it("MessageRepository returns ordered session messages", async () => {
    const repositories = createRepositoryFixture();
    const message = createMessage({
      id: "message-1",
      sessionId: "session-1",
      role: "user",
      content: "look around",
      createdAt: new Date("2026-01-01T00:00:00.000Z")
    });

    await repositories.messages.save(message);

    await expect(repositories.messages.listBySessionId(message.sessionId)).resolves.toEqual([message]);
  });

  it("ArtifactRepository lists artifacts by owning session", async () => {
    const repositories = createRepositoryFixture();
    const artifact = createArtifact({
      id: "artifact-1",
      sessionId: "session-1",
      kind: "image",
      uri: "artifacts/image-1.png",
      mediaType: "image/png",
      createdAt: new Date("2026-01-01T00:00:00.000Z")
    });

    await repositories.artifacts.save(artifact);

    await expect(repositories.artifacts.listBySessionId(artifact.sessionId)).resolves.toEqual([artifact]);
  });

  it("ArchiveVersionRepository preserves archive lineage by session", async () => {
    const repositories = createRepositoryFixture();
    const version = createArchiveVersion({
      id: "archive-1",
      sessionId: "session-1",
      turnCutoff: 3,
      stateSnapshot: { hp: 10 },
      workingSummary: "The player entered the ruins.",
      archiveSummary: "Act 1 recap",
      createdAt: new Date("2026-01-01T00:00:00.000Z")
    });

    await repositories.archiveVersions.save(version);

    await expect(repositories.archiveVersions.getById(version.id)).resolves.toEqual(version);
    await expect(repositories.archiveVersions.listBySessionId(version.sessionId)).resolves.toEqual([version]);
  });

  it("MemoryDocumentRepository loads indexed memory by id and scope", async () => {
    const repositories = createRepositoryFixture();
    const document = createMemoryDocument({
      id: "memory-1",
      sourceType: "world",
      scope: "world:world-1",
      title: "World overview",
      content: "Northreach is a frontier kingdom.",
      metadata: { tags: ["world"] },
      provenance: { sourceId: "world-1" }
    });

    await repositories.memoryDocuments.save(document);

    await expect(repositories.memoryDocuments.getById(document.id)).resolves.toEqual(document);
    await expect(repositories.memoryDocuments.listByScope(document.scope)).resolves.toEqual([document]);
  });

  it("RetrievalRunRepository records retrieval history per session", async () => {
    const repositories = createRepositoryFixture();
    const run = createRetrievalRun({
      id: "retrieval-1",
      sessionId: "session-1",
      query: "Where is the observatory key?",
      rewrittenQueries: ["observatory key location"],
      selectedSources: ["world", "archive"],
      candidates: ["chunk-1", "chunk-2"],
      selectedChunks: ["chunk-2"],
      critique: "Enough evidence to answer.",
      latencyMs: 12
    });

    await repositories.retrievalRuns.save(run);

    await expect(repositories.retrievalRuns.listBySessionId(run.sessionId)).resolves.toEqual([run]);
  });

  it("TraceRecordRepository groups trace events by trace id", async () => {
    const repositories = createRepositoryFixture();
    const record = createTraceRecord({
      traceId: "trace-1",
      spanId: "span-1",
      sessionId: "session-1",
      turnId: "turn-1",
      component: "turn-flow",
      eventType: "model.completed",
      payload: { tokens: 120 },
      createdAt: new Date("2026-01-01T00:00:00.000Z")
    });

    await repositories.traceRecords.save(record);

    await expect(repositories.traceRecords.listByTraceId(record.traceId)).resolves.toEqual([record]);
  });
});
