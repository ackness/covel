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
} from "../src/index.js";

describe("domain entity invariants", () => {
  it("World requires a stable id and a non-empty name", () => {
    expect(() =>
      createWorld({
        id: "",
        name: "",
        description: "A cold open world.",
        createdAt: new Date("2026-01-01T00:00:00.000Z")
      })
    ).toThrow(/world/i);
  });

  it("Session belongs to a world and uses a supported status", () => {
    expect(() =>
      createSession({
        id: "session-1",
        worldId: "",
        status: "paused" as never,
        createdAt: new Date("2026-01-01T00:00:00.000Z")
      })
    ).toThrow(/session/i);
  });

  it("Message requires a supported role and non-empty content", () => {
    expect(() =>
      createMessage({
        id: "message-1",
        sessionId: "session-1",
        role: "tool" as never,
        content: "",
        createdAt: new Date("2026-01-01T00:00:00.000Z")
      })
    ).toThrow(/message/i);
  });

  it("Artifact requires session ownership and durable locator data", () => {
    expect(() =>
      createArtifact({
        id: "",
        sessionId: "",
        kind: "",
        uri: "",
        mediaType: "",
        createdAt: new Date("2026-01-01T00:00:00.000Z")
      })
    ).toThrow(/artifact/i);
  });

  it("ArchiveVersion requires a non-negative cutoff and summary payloads", () => {
    expect(() =>
      createArchiveVersion({
        id: "archive-1",
        sessionId: "session-1",
        turnCutoff: -1,
        stateSnapshot: {},
        workingSummary: "",
        archiveSummary: "",
        createdAt: new Date("2026-01-01T00:00:00.000Z")
      })
    ).toThrow(/archive/i);
  });

  it("MemoryDocument requires indexable content and provenance metadata", () => {
    expect(() =>
      createMemoryDocument({
        id: "memory-1",
        sourceType: "",
        scope: "",
        title: "",
        content: "",
        metadata: {},
        provenance: {}
      })
    ).toThrow(/memory/i);
  });

  it("RetrievalRun requires a query and non-negative latency", () => {
    expect(() =>
      createRetrievalRun({
        id: "retrieval-1",
        sessionId: "session-1",
        query: "",
        rewrittenQueries: [],
        selectedSources: [],
        candidates: [],
        selectedChunks: [],
        critique: "",
        latencyMs: -5
      })
    ).toThrow(/retrieval/i);
  });

  it("TraceRecord requires correlation identifiers and typed event metadata", () => {
    expect(() =>
      createTraceRecord({
        traceId: "",
        spanId: "",
        sessionId: "",
        turnId: "",
        component: "",
        eventType: "",
        payload: {},
        createdAt: new Date("invalid")
      })
    ).toThrow(/trace/i);
  });

  it("PackageStateRecord requires stable package-scoped coordinates", () => {
    expect(() =>
      createPackageStateRecord({
        scope: "project" as never,
        ownerId: "",
        packageName: "",
        collection: "",
        key: "",
        value: {},
        updatedAt: new Date("invalid")
      })
    ).toThrow(/package-state/i);
  });

  it("JobRecord requires a supported status and non-negative attempts", () => {
    expect(() =>
      createJobRecord({
        id: "",
        packageName: "",
        jobType: "",
        status: "unknown" as never,
        input: {},
        attempt: -1,
        createdAt: new Date("invalid")
      })
    ).toThrow(/job/i);
  });
});
