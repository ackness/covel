import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { newDb } from "pg-mem";
import { afterEach, describe, expect, it } from "vitest";

import { createSession } from "../../domain/src/index.js";
import { createInMemoryStorageRepositories, createPostgresStoragePort, type PostgresStoragePort } from "../src/index.js";

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
    createPool(): PgPoolLike {
      return new adapter.Pool();
    }
  };
}

describe("session task binding persistence", () => {
  const roots: string[] = [];
  const pools: PgPoolLike[] = [];

  afterEach(async () => {
    await Promise.allSettled(pools.splice(0, pools.length).map((pool) => pool.end()));
    await Promise.all(
      roots.splice(0, roots.length).map((root) => rm(root, { recursive: true, force: true }))
    );
  });

  it("persists taskBindings for in-memory session repositories", async () => {
    const repositories = createInMemoryStorageRepositories();
    const session = createSession({
      id: "session-1",
      worldId: "world-1",
      status: "active",
      taskBindings: {
        "story.narration": "story-default",
        "story.choice-generation": "choice-fast"
      },
      createdAt: new Date("2026-01-01T00:00:00.000Z")
    });

    await repositories.sessions.save(session);

    await expect(repositories.sessions.getById(session.id)).resolves.toEqual(session);
    await expect(repositories.sessions.listByWorldId(session.worldId)).resolves.toEqual([session]);
  });

  it("persists taskBindings for postgres-backed session repositories", async () => {
    const harness = createPgMemHarness();
    const artifactRootDirectory = await mkdtemp(join(tmpdir(), "covel-storage-session-preset-"));
    const pool = harness.createPool();

    roots.push(artifactRootDirectory);
    pools.push(pool);

    const port = createConfiguredPostgresStoragePort({
      pool,
      artifactRootDirectory
    });
    const repositories = await port.createRepositories();
    const session = createSession({
      id: "session-1",
      worldId: "world-1",
      status: "active",
      taskBindings: {
        "story.narration": "story-default",
        "story.choice-generation": "choice-fast"
      },
      createdAt: new Date("2026-01-01T00:00:00.000Z")
    });

    await repositories.sessions.save(session);

    await expect(repositories.sessions.getById(session.id)).resolves.toEqual({
      ...session,
      presetId: "story-default"
    });
    await expect(repositories.sessions.listByWorldId(session.worldId)).resolves.toEqual([
      {
        ...session,
        presetId: "story-default"
      }
    ]);
  });
});
