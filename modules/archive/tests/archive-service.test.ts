import { describe, expect, it } from "vitest";

import {
  createArtifact,
  createMessage,
  createSession,
  createWorld
} from "../../domain/src/index.js";
import { createInMemoryStorageRepositories } from "../../storage/src/index.js";
import {
  createArchiveService,
  createInMemoryArchiveLineageStore,
  createInMemoryReindexMarkStore
} from "../src/index.js";

describe("archive service", () => {
  it("creates a snapshot with the requested cutoff and involved artifact metadata", async () => {
    const fixture = await createFixture();

    const snapshot = await fixture.service.createSnapshot({
      sessionId: fixture.session.id,
      turnCutoff: 2,
      stateSnapshot: { scene: "gatehouse" },
      workingSummary: "The scout reached the gatehouse.",
      archiveSummary: "Act 1 summary"
    });

    expect(snapshot.version.sessionId).toBe(fixture.session.id);
    expect(snapshot.version.turnCutoff).toBe(2);
    expect(snapshot.version.stateSnapshot).toEqual({
      scene: "gatehouse",
      involvedArtifacts: [
        {
          id: fixture.artifact.id,
          kind: fixture.artifact.kind,
          uri: fixture.artifact.uri,
          mediaType: fixture.artifact.mediaType,
          createdAt: fixture.artifact.createdAt.toISOString()
        }
      ]
    });
    await expect(
      fixture.repositories.archiveVersions.getById(snapshot.version.id)
    ).resolves.toEqual(snapshot.version);
  });

  it("restores in place, records lineage, and marks the session scope for reindex", async () => {
    const fixture = await createFixture();
    const snapshot = await fixture.service.createSnapshot({
      sessionId: fixture.session.id,
      turnCutoff: 1,
      stateSnapshot: { scene: "courtyard" },
      workingSummary: "The party is at the courtyard.",
      archiveSummary: "Before the vault opened"
    });

    const restored = await fixture.service.restoreInPlace({
      archiveVersionId: snapshot.version.id
    });

    expect(restored.session.id).toBe(fixture.session.id);
    expect(restored.session.status).toBe("active");
    expect(restored.snapshot.version.id).toBe(snapshot.version.id);
    expect(restored.lineageEntry).toMatchObject({
      archiveVersionId: snapshot.version.id,
      targetSessionId: fixture.session.id,
      sourceSessionId: fixture.session.id,
      restoreMode: "restore-in-place"
    });
    expect(await fixture.lineageStore.listBySessionId(fixture.session.id)).toEqual([
      restored.lineageEntry
    ]);
    expect(await fixture.reindexMarkStore.listPending()).toEqual([
      {
        archiveVersionId: snapshot.version.id,
        sourceSessionId: fixture.session.id,
        scope: `session:${fixture.session.id}`,
        status: "pending"
      }
    ]);
  });

  it("restores as fork with a new session id and preserves lineage to the source session", async () => {
    const fixture = await createFixture();
    const snapshot = await fixture.service.createSnapshot({
      sessionId: fixture.session.id,
      turnCutoff: 2,
      stateSnapshot: { scene: "vault" },
      workingSummary: "The vault is unlocked.",
      archiveSummary: "Vault branch point"
    });

    const restored = await fixture.service.restoreAsFork({
      archiveVersionId: snapshot.version.id
    });

    expect(restored.session.id).toBe("session-2");
    expect(restored.session.worldId).toBe(fixture.session.worldId);
    expect(restored.session.status).toBe("active");
    expect(restored.lineageEntry).toMatchObject({
      archiveVersionId: snapshot.version.id,
      sourceSessionId: fixture.session.id,
      targetSessionId: "session-2",
      restoreMode: "restore-as-fork"
    });
    expect(await fixture.repositories.sessions.getById("session-2")).toEqual(restored.session);
    expect(await fixture.lineageStore.listBySessionId("session-2")).toEqual([restored.lineageEntry]);
  });

  it("lists lineage for both the source session and forked sessions in chronological order", async () => {
    const fixture = await createFixture();
    const firstSnapshot = await fixture.service.createSnapshot({
      sessionId: fixture.session.id,
      turnCutoff: 1,
      stateSnapshot: { scene: "camp" },
      workingSummary: "Camp established.",
      archiveSummary: "Camp summary"
    });
    await fixture.service.restoreInPlace({ archiveVersionId: firstSnapshot.version.id });

    const secondSnapshot = await fixture.service.createSnapshot({
      sessionId: fixture.session.id,
      turnCutoff: 2,
      stateSnapshot: { scene: "tower" },
      workingSummary: "Tower breached.",
      archiveSummary: "Tower summary"
    });
    const forkRestore = await fixture.service.restoreAsFork({
      archiveVersionId: secondSnapshot.version.id
    });

    await expect(fixture.service.listLineage({ sessionId: fixture.session.id })).resolves.toEqual([
      expect.objectContaining({
        archiveVersionId: firstSnapshot.version.id,
        targetSessionId: fixture.session.id,
        restoreMode: "restore-in-place"
      }),
      expect.objectContaining({
        archiveVersionId: secondSnapshot.version.id,
        targetSessionId: "session-2",
        restoreMode: "restore-as-fork"
      })
    ]);
    await expect(fixture.service.listLineage({ sessionId: "session-2" })).resolves.toEqual([
      forkRestore.lineageEntry
    ]);
  });

  it("deduplicates reindex marks per archive version and session scope", async () => {
    const fixture = await createFixture();
    const snapshot = await fixture.service.createSnapshot({
      sessionId: fixture.session.id,
      turnCutoff: 2,
      stateSnapshot: { scene: "vault" },
      workingSummary: "The vault is unlocked.",
      archiveSummary: "Vault branch point"
    });

    await fixture.service.restoreInPlace({ archiveVersionId: snapshot.version.id });
    await fixture.service.restoreInPlace({ archiveVersionId: snapshot.version.id });

    await expect(fixture.reindexMarkStore.listPending()).resolves.toEqual([
      {
        archiveVersionId: snapshot.version.id,
        sourceSessionId: fixture.session.id,
        scope: `session:${fixture.session.id}`,
        status: "pending"
      }
    ]);
  });
});

async function createFixture() {
  const repositories = createInMemoryStorageRepositories();
  const lineageStore = createInMemoryArchiveLineageStore();
  const reindexMarkStore = createInMemoryReindexMarkStore();
  const service = createArchiveService({
    repositories,
    lineageStore,
    reindexMarkStore,
    now: () => new Date("2026-02-01T00:00:00.000Z"),
    createId: createDeterministicIdFactory()
  });

  const world = createWorld({
    id: "world-1",
    name: "Northreach",
    description: "Frozen frontier world",
    createdAt: new Date("2026-01-01T00:00:00.000Z")
  });
  const session = createSession({
    id: "session-1",
    worldId: world.id,
    status: "waiting_for_input",
    createdAt: new Date("2026-01-01T00:00:01.000Z")
  });
  const firstMessage = createMessage({
    id: "message-1",
    sessionId: session.id,
    role: "user",
    content: "Open the gate",
    createdAt: new Date("2026-01-01T00:00:02.000Z")
  });
  const secondMessage = createMessage({
    id: "message-2",
    sessionId: session.id,
    role: "assistant",
    content: "The gate opens with a groan.",
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

  await repositories.worlds.save(world);
  await repositories.sessions.save(session);
  await repositories.messages.save(firstMessage);
  await repositories.messages.save(secondMessage);
  await repositories.artifacts.save(artifact);

  return {
    repositories,
    lineageStore,
    reindexMarkStore,
    service,
    world,
    session,
    artifact
  };
}

function createDeterministicIdFactory() {
  let nextSessionId = 2;
  let nextArchiveId = 1;
  let nextLineageId = 1;

  return (kind: string) => {
    if (kind === "archive-version") {
      return `archive-${nextArchiveId++}`;
    }

    if (kind === "archive-lineage") {
      return `lineage-${nextLineageId++}`;
    }

    if (kind === "session") {
      return `session-${nextSessionId++}`;
    }

    return `${kind}-1`;
  };
}
