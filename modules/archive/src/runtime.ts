import { createArchiveVersion, createSession, type ArchiveVersion, type Artifact, type DomainRepositories, type Session } from "../../domain/src/index.js";

export interface ArchiveLineageEntry {
  id: string;
  archiveVersionId: string;
  sourceSessionId: string;
  targetSessionId: string;
  restoreMode: "restore-in-place" | "restore-as-fork";
  createdAt: string;
}

export interface ReindexMark {
  archiveVersionId: string;
  sourceSessionId: string;
  scope: string;
  status: "pending";
}

export interface ArchiveLineageStore {
  append(entry: ArchiveLineageEntry): Promise<void>;
  listBySessionId(sessionId: string): Promise<ArchiveLineageEntry[]>;
}

export interface ReindexMarkStore {
  mark(mark: ReindexMark): Promise<void>;
  listPending(): Promise<ReindexMark[]>;
}

export function createInMemoryArchiveLineageStore(): ArchiveLineageStore {
  const entries: ArchiveLineageEntry[] = [];

  return {
    async append(entry) {
      entries.push(entry);
    },
    async listBySessionId(sessionId) {
      return entries.filter(
        (entry) => entry.sourceSessionId === sessionId || entry.targetSessionId === sessionId
      );
    }
  };
}

export function createInMemoryReindexMarkStore(): ReindexMarkStore {
  const marks = new Map<string, ReindexMark>();

  return {
    async mark(mark) {
      marks.set(`${mark.archiveVersionId}:${mark.scope}`, mark);
    },
    async listPending() {
      return Array.from(marks.values());
    }
  };
}

export function createArchiveService(dependencies: {
  repositories: DomainRepositories;
  lineageStore: ArchiveLineageStore;
  reindexMarkStore: ReindexMarkStore;
  now(): Date;
  createId(kind: string): string;
}) {
  async function createSnapshot(input: {
    sessionId: string;
    turnCutoff: number;
    stateSnapshot: Record<string, unknown>;
    workingSummary: string;
    archiveSummary: string;
  }) {
    const involvedArtifacts = (await dependencies.repositories.artifacts.listBySessionId(input.sessionId)).map(
      (artifact) => toArtifactSnapshot(artifact)
    );

    const version = createArchiveVersion({
      id: dependencies.createId("archive-version"),
      sessionId: input.sessionId,
      turnCutoff: input.turnCutoff,
      stateSnapshot: {
        ...input.stateSnapshot,
        involvedArtifacts
      },
      workingSummary: input.workingSummary,
      archiveSummary: input.archiveSummary,
      createdAt: dependencies.now()
    });

    await dependencies.repositories.archiveVersions.save(version);

    return {
      version
    };
  }

  async function restoreInPlace(input: {
    archiveVersionId: string;
  }) {
    const snapshot = await getSnapshotOrThrow(input.archiveVersionId);
    const session = await getSessionOrThrow(snapshot.version.sessionId);
    const restoredSession = createSession({
      ...session,
      status: "active",
      createdAt: session.createdAt
    });
    await dependencies.repositories.sessions.save(restoredSession);

    const lineageEntry = await recordLineage({
      archiveVersionId: snapshot.version.id,
      sourceSessionId: session.id,
      targetSessionId: session.id,
      restoreMode: "restore-in-place"
    });

    await markReindex(snapshot.version.id, session.id);

    return {
      session: restoredSession,
      snapshot,
      lineageEntry
    };
  }

  async function restoreAsFork(input: {
    archiveVersionId: string;
  }) {
    const snapshot = await getSnapshotOrThrow(input.archiveVersionId);
    const sourceSession = await getSessionOrThrow(snapshot.version.sessionId);
    const forkSession = createSession({
      id: dependencies.createId("session"),
      worldId: sourceSession.worldId,
      status: "active",
      createdAt: dependencies.now()
    });
    await dependencies.repositories.sessions.save(forkSession);

    const lineageEntry = await recordLineage({
      archiveVersionId: snapshot.version.id,
      sourceSessionId: sourceSession.id,
      targetSessionId: forkSession.id,
      restoreMode: "restore-as-fork"
    });

    await markReindex(snapshot.version.id, sourceSession.id);

    return {
      session: forkSession,
      snapshot,
      lineageEntry
    };
  }

  async function listLineage(input: { sessionId: string }) {
    return dependencies.lineageStore.listBySessionId(input.sessionId);
  }

  async function getSnapshotOrThrow(archiveVersionId: string) {
    const version = await dependencies.repositories.archiveVersions.getById(archiveVersionId);
    if (!version) {
      throw new Error(`Archive version '${archiveVersionId}' was not found.`);
    }

    return {
      version
    };
  }

  async function getSessionOrThrow(sessionId: string): Promise<Session> {
    const session = await dependencies.repositories.sessions.getById(sessionId);
    if (!session) {
      throw new Error(`Session '${sessionId}' was not found.`);
    }

    return session;
  }

  async function recordLineage(input: Omit<ArchiveLineageEntry, "id" | "createdAt">) {
    const entry: ArchiveLineageEntry = {
      id: dependencies.createId("archive-lineage"),
      createdAt: dependencies.now().toISOString(),
      ...input
    };
    await dependencies.lineageStore.append(entry);
    return entry;
  }

  async function markReindex(archiveVersionId: string, sourceSessionId: string) {
    await dependencies.reindexMarkStore.mark({
      archiveVersionId,
      sourceSessionId,
      scope: `session:${sourceSessionId}`,
      status: "pending"
    });
  }

  return {
    createSnapshot,
    restoreInPlace,
    restoreAsFork,
    listLineage
  };
}

function toArtifactSnapshot(artifact: Artifact) {
  return {
    id: artifact.id,
    kind: artifact.kind,
    uri: artifact.uri,
    mediaType: artifact.mediaType,
    createdAt: artifact.createdAt.toISOString()
  };
}
