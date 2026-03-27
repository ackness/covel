import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { newDb } from "pg-mem";
import { afterEach, describe, expect, it } from "vitest";
import type { WorkflowSnapshotRecord } from "../../contracts/src/index.js";

import {
  createArchiveVersion,
  createArtifact,
  createJobRecord,
  createMessage,
  createPackageStateRecord,
  createSession,
  createWorld
} from "../../domain/src/index.js";
import {
  createArtifactPathPolicy,
  createPostgresStoragePort,
  type ArtifactBlobMetadata,
  type PostgresStoragePort
} from "../src/index.js";

interface PgQueryResult<Row> {
  rows: Row[];
}

interface PgPoolLike {
  query<Row>(text: string, values?: unknown[]): Promise<PgQueryResult<Row>>;
  end(): Promise<void>;
}

interface ExperimentalPostgresStoragePortOptions {
  pool: PgPoolLike;
  artifactRootDirectory: string;
}

const createConfiguredPostgresStoragePort = createPostgresStoragePort as unknown as (
  options: ExperimentalPostgresStoragePortOptions
) => PostgresStoragePort;

function createPgMemHarness() {
  const db = newDb({ autoCreateForeignKeyIndices: true });
  const adapter = db.adapters.createPg();

  return {
    db,
    createPool(): PgPoolLike {
      return new adapter.Pool();
    }
  };
}

function createFixtures() {
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
    stateSnapshot: { hp: 10, location: "courtyard" },
    workingSummary: "The player entered the ruins.",
    archiveSummary: "Act 1 recap",
    createdAt: new Date("2026-01-01T00:00:05.000Z")
  });
  const artifactMetadata: ArtifactBlobMetadata = {
    artifactId: artifact.id,
    sessionId: session.id,
    kind: artifact.kind,
    mediaType: artifact.mediaType,
    fileName: "map.png",
    createdAt: "2026-01-01T00:00:04.000Z",
    byteLength: 3
  };

  return {
    world,
    session,
    firstMessage,
    secondMessage,
    artifact,
    archiveVersion,
    artifactMetadata
  };
}

describe("createPostgresStoragePort", () => {
  const roots: string[] = [];
  const pools: PgPoolLike[] = [];

  afterEach(async () => {
    await Promise.allSettled(pools.splice(0, pools.length).map((pool) => pool.end()));
    await Promise.all(
      roots.splice(0, roots.length).map((root) => rm(root, { recursive: true, force: true }))
    );
  });

  async function createPort(
    harness: ReturnType<typeof createPgMemHarness>,
    artifactRootDirectory?: string
  ) {
    const root = artifactRootDirectory ?? (await mkdtemp(join(tmpdir(), "covel-storage-pg-")));
    const pool = harness.createPool();

    roots.push(root);
    pools.push(pool);

    return createConfiguredPostgresStoragePort({
      pool,
      artifactRootDirectory: root
    });
  }

  it("bootstraps the postgres schema idempotently against an in-memory pg-mem database", async () => {
    const harness = createPgMemHarness();
    const port = await createPort(harness);

    const repositories = await port.createRepositories();
    const recreatedRepositories = await port.createRepositories();

    expect(repositories.worlds.save).toBeTypeOf("function");
    expect(recreatedRepositories.messages.listBySessionId).toBeTypeOf("function");

    const queryResult = await harness
      .createPool()
      .query<{ table_name: string }>(
        "select table_name from information_schema.tables where table_schema = 'public'"
      );

    expect(queryResult.rows.map((row) => row.table_name)).toEqual(
      expect.arrayContaining([
        "worlds",
        "sessions",
        "messages",
        "artifacts",
        "archive_versions"
      ])
    );
  });

  it("persists worlds, sessions, messages, artifacts, and archive versions across adapter restarts", async () => {
    const harness = createPgMemHarness();
    const firstPort = await createPort(harness);
    const firstRepositories = await firstPort.createRepositories();
    const fixtures = createFixtures();

    await firstRepositories.worlds.save(fixtures.world);
    await firstRepositories.sessions.save(fixtures.session);
    await firstRepositories.messages.save(fixtures.secondMessage);
    await firstRepositories.messages.save(fixtures.firstMessage);
    await firstRepositories.artifacts.save(fixtures.artifact);
    await firstRepositories.archiveVersions.save(fixtures.archiveVersion);

    const secondPort = await createPort(harness);
    const secondRepositories = await secondPort.createRepositories();

    await expect(secondRepositories.worlds.getById(fixtures.world.id)).resolves.toEqual(
      fixtures.world
    );
    await expect(secondRepositories.sessions.getById(fixtures.session.id)).resolves.toEqual(
      fixtures.session
    );
    await expect(
      secondRepositories.sessions.listByWorldId(fixtures.world.id)
    ).resolves.toEqual([fixtures.session]);
    await expect(
      secondRepositories.messages.listBySessionId(fixtures.session.id)
    ).resolves.toEqual([fixtures.firstMessage, fixtures.secondMessage]);
    await expect(
      secondRepositories.artifacts.listBySessionId(fixtures.session.id)
    ).resolves.toEqual([fixtures.artifact]);
    await expect(
      secondRepositories.archiveVersions.getById(fixtures.archiveVersion.id)
    ).resolves.toEqual(fixtures.archiveVersion);
    await expect(
      secondRepositories.archiveVersions.listBySessionId(fixtures.session.id)
    ).resolves.toEqual([fixtures.archiveVersion]);
  });

  it("keeps artifact repository rows and local artifact metadata coordinated but separate", async () => {
    const harness = createPgMemHarness();
    const artifactRoot = await mkdtemp(join(tmpdir(), "covel-storage-pg-artifacts-"));
    roots.push(artifactRoot);

    const firstPort = await createPort(harness, artifactRoot);
    const repositories = await firstPort.createRepositories();
    const artifactStore = await firstPort.createArtifactStore();
    const fixtures = createFixtures();

    await repositories.artifacts.save(fixtures.artifact);
    await expect(artifactStore.readMetadata(fixtures.artifact.id)).resolves.toBeNull();

    const storedArtifact = await artifactStore.put({
      metadata: fixtures.artifactMetadata,
      content: Buffer.from([1, 2, 3])
    });

    await repositories.artifacts.save({
      ...fixtures.artifact,
      uri: storedArtifact.path
    });

    const secondPort = await createPort(harness, artifactRoot);
    const secondRepositories = await secondPort.createRepositories();
    const secondArtifactStore = await secondPort.createArtifactStore();

    await expect(
      secondRepositories.artifacts.listBySessionId(fixtures.session.id)
    ).resolves.toEqual([
      {
        ...fixtures.artifact,
        uri: storedArtifact.path
      }
    ]);
    await expect(secondArtifactStore.readMetadata(fixtures.artifact.id)).resolves.toEqual({
      ...fixtures.artifactMetadata,
      byteLength: 3,
      checksum:
        "sha256:039058c6f2c0cb492c533b0a4d14ef77cc0f78abccced5287d84a1a2011cfb81",
      path: createArtifactPathPolicy().toArtifactPath(fixtures.artifactMetadata)
    });
    await expect(secondArtifactStore.readContent(fixtures.artifact.id)).resolves.toEqual(
      Buffer.from([1, 2, 3])
    );
  });

  it("persists package state, jobs, and richer pending blocks across adapter restarts", async () => {
    const harness = createPgMemHarness();
    const firstPort = await createPort(harness);
    const firstRepositories = await firstPort.createRepositories();

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
    const workflowSnapshot: WorkflowSnapshotRecord = {
      runId: "flow-1",
      stepId: "turn-1",
      sessionId: "session-1",
      status: "suspended",
      suspendPayload: {
        blockId: "blk_01"
      },
      updatedAt: "2026-01-01T00:00:12.000Z"
    };

    await firstRepositories.packageState.save(packageState);
    await firstRepositories.jobs.save(job);
    await firstRepositories.workflowSnapshots.save(workflowSnapshot);
    await firstRepositories.pendingBlocks.save({
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

    const secondPort = await createPort(harness);
    const secondRepositories = await secondPort.createRepositories();

    await expect(secondRepositories.packageState.get({
      scope: "session",
      ownerId: "session-1",
      packageName: "director-choices",
      collection: "choice_state",
      key: "turn-1"
    })).resolves.toEqual(packageState);
    await expect(secondRepositories.jobs.getById("job-1")).resolves.toEqual(job);
    await expect(secondRepositories.jobs.listBySessionId("session-1")).resolves.toEqual([job]);
    await expect(secondRepositories.workflowSnapshots.getByRunId("flow-1")).resolves.toEqual(workflowSnapshot);
    await expect(secondRepositories.workflowSnapshots.listBySessionId("session-1")).resolves.toEqual([workflowSnapshot]);
    await expect(secondRepositories.pendingBlocks.getByBlockId("blk_01")).resolves.toEqual({
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
