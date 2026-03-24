import type { DomainRepositories } from "../../src/index.js";

export function createRepositoryFixture(): DomainRepositories {
  const worlds = new Map<string, Awaited<ReturnType<DomainRepositories["worlds"]["getById"]>> extends infer T ? Exclude<T, null> : never>();
  const sessions = new Map<string, Awaited<ReturnType<DomainRepositories["sessions"]["getById"]>> extends infer T ? Exclude<T, null> : never>();
  const messages = new Map<string, import("../../src/index.js").Message>();
  const artifacts = new Map<string, import("../../src/index.js").Artifact>();
  const archiveVersions = new Map<string, import("../../src/index.js").ArchiveVersion>();
  const memoryDocuments = new Map<string, import("../../src/index.js").MemoryDocument>();
  const retrievalRuns = new Map<string, import("../../src/index.js").RetrievalRun>();
  const traceRecords = new Map<string, import("../../src/index.js").TraceRecord>();

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
    }
  };
}
