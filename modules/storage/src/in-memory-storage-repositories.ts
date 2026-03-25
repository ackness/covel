import type {
  ArchiveVersion,
  Artifact,
  DomainRepositories,
  DomainRepositoriesWithPackageStateAndJobs,
  JobRecord,
  MemoryDocument,
  Message,
  PackageStateRecord,
  RetrievalRun,
  Session,
  TraceRecord,
  World
} from "../../domain/src/index.js";
import type {
  PersistedPendingBlockRecord,
  StorageRepositoriesWithPendingBlocks
} from "./pending-block-store.js";
import type { StorageRepositoriesWithPackageStateAndJobs } from "./package-state-store.js";
import type { PersistedPresetRecord, StorageRepositoriesWithPresets } from "./preset-metadata-store.js";
import { stripPresetSecrets } from "./preset-metadata-store.js";

export function createInMemoryStorageRepositories(): DomainRepositories &
  StorageRepositoriesWithPresets &
  StorageRepositoriesWithPendingBlocks &
  StorageRepositoriesWithPackageStateAndJobs {
  const worlds = new Map<string, World>();
  const sessions = new Map<string, Session>();
  const messages = new Map<string, Message>();
  const artifacts = new Map<string, Artifact>();
  const archiveVersions = new Map<string, ArchiveVersion>();
  const memoryDocuments = new Map<string, MemoryDocument>();
  const retrievalRuns = new Map<string, RetrievalRun>();
  const traceRecords = new Map<string, TraceRecord>();
  const presets = new Map<string, PersistedPresetRecord>();
  const pendingBlocks = new Map<string, PersistedPendingBlockRecord>();
  const packageState = new Map<string, PackageStateRecord>();
  const jobs = new Map<string, JobRecord>();

  return {
    worlds: {
      async save(world) {
        worlds.set(world.id, world);
      },
      async getById(id) {
        return worlds.get(id) ?? null;
      },
      async list() {
        return Array.from(worlds.values());
      }
    },
    sessions: {
      async save(session) {
        sessions.set(session.id, session);
      },
      async getById(id) {
        return sessions.get(id) ?? null;
      },
      async listByWorldId(worldId) {
        return Array.from(sessions.values()).filter((session) => session.worldId === worldId);
      }
    },
    messages: {
      async save(message) {
        messages.set(message.id, message);
      },
      async listBySessionId(sessionId) {
        return Array.from(messages.values())
          .filter((message) => message.sessionId === sessionId)
          .sort((left, right) => left.createdAt.getTime() - right.createdAt.getTime());
      }
    },
    artifacts: {
      async save(artifact) {
        artifacts.set(artifact.id, artifact);
      },
      async listBySessionId(sessionId) {
        return Array.from(artifacts.values()).filter((artifact) => artifact.sessionId === sessionId);
      }
    },
    archiveVersions: {
      async save(version) {
        archiveVersions.set(version.id, version);
      },
      async getById(id) {
        return archiveVersions.get(id) ?? null;
      },
      async listBySessionId(sessionId) {
        return Array.from(archiveVersions.values()).filter((version) => version.sessionId === sessionId);
      }
    },
    memoryDocuments: {
      async save(document) {
        memoryDocuments.set(document.id, document);
      },
      async getById(id) {
        return memoryDocuments.get(id) ?? null;
      },
      async listByScope(scope) {
        return Array.from(memoryDocuments.values()).filter((document) => document.scope === scope);
      }
    },
    retrievalRuns: {
      async save(run) {
        retrievalRuns.set(run.id, run);
      },
      async listBySessionId(sessionId) {
        return Array.from(retrievalRuns.values()).filter((run) => run.sessionId === sessionId);
      }
    },
    traceRecords: {
      async save(record) {
        traceRecords.set(`${record.traceId}:${record.spanId}`, record);
      },
      async listByTraceId(traceId) {
        return Array.from(traceRecords.values()).filter((record) => record.traceId === traceId);
      }
    },
    pendingBlocks: {
      async save(input) {
        pendingBlocks.set(input.blockId, { ...input });
      },
      async getByBlockId(blockId) {
        return pendingBlocks.get(blockId) ?? null;
      },
      async delete(blockId) {
        pendingBlocks.delete(blockId);
      }
    },
    packageState: {
      async save(record) {
        packageState.set(buildPackageStateKey(record), { ...record });
      },
      async get(input) {
        return packageState.get(buildPackageStateKey(input)) ?? null;
      },
      async listByCollection(input) {
        return Array.from(packageState.values()).filter((record) =>
          record.scope === input.scope &&
          record.ownerId === input.ownerId &&
          record.packageName === input.packageName &&
          record.collection === input.collection
        );
      }
    },
    jobs: {
      async save(record) {
        jobs.set(record.id, { ...record });
      },
      async getById(id) {
        return jobs.get(id) ?? null;
      },
      async listBySessionId(sessionId) {
        return Array.from(jobs.values()).filter((record) => record.sessionId === sessionId);
      },
      async listByStatus(status) {
        return Array.from(jobs.values()).filter((record) => record.status === status);
      }
    },
    presets: {
      async save(input) {
        presets.set(input.id, { ...input });
      },
      async patch(presetId, input) {
        const existing = presets.get(presetId);
        const next = {
          ...(existing ?? {
            id: presetId
          }),
          ...input,
          id: presetId
        } as PersistedPresetRecord;
        presets.set(presetId, next);
        return stripPresetSecrets(next);
      },
      async getById(id) {
        const preset = presets.get(id);
        return preset ? stripPresetSecrets(preset) : null;
      },
      async list() {
        return Array.from(presets.values()).map(stripPresetSecrets);
      }
    }
  };
}

function buildPackageStateKey(input: {
  scope: PackageStateRecord["scope"];
  ownerId: string;
  packageName: string;
  collection: string;
  key: string;
}): string {
  return `${input.scope}:${input.ownerId}:${input.packageName}:${input.collection}:${input.key}`;
}
