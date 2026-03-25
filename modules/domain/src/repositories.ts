import type {
  ArchiveVersion,
  Artifact,
  JobRecord,
  MemoryDocument,
  Message,
  PackageStateRecord,
  RetrievalRun,
  Session,
  TraceRecord,
  World
} from "./entities.js";

export interface WorldRepository {
  save(world: World): Promise<void>;
  getById(id: string): Promise<World | null>;
  list(): Promise<World[]>;
}

export interface SessionRepository {
  save(session: Session): Promise<void>;
  getById(id: string): Promise<Session | null>;
  listByWorldId(worldId: string): Promise<Session[]>;
}

export interface MessageRepository {
  save(message: Message): Promise<void>;
  listBySessionId(sessionId: string): Promise<Message[]>;
}

export interface ArtifactRepository {
  save(artifact: Artifact): Promise<void>;
  listBySessionId(sessionId: string): Promise<Artifact[]>;
}

export interface ArchiveVersionRepository {
  save(version: ArchiveVersion): Promise<void>;
  getById(id: string): Promise<ArchiveVersion | null>;
  listBySessionId(sessionId: string): Promise<ArchiveVersion[]>;
}

export interface MemoryDocumentRepository {
  save(document: MemoryDocument): Promise<void>;
  getById(id: string): Promise<MemoryDocument | null>;
  listByScope(scope: string): Promise<MemoryDocument[]>;
}

export interface RetrievalRunRepository {
  save(run: RetrievalRun): Promise<void>;
  listBySessionId(sessionId: string): Promise<RetrievalRun[]>;
}

export interface TraceRecordRepository {
  save(record: TraceRecord): Promise<void>;
  listByTraceId(traceId: string): Promise<TraceRecord[]>;
}

export interface PackageStateRepository {
  save(record: PackageStateRecord): Promise<void>;
  get(input: {
    scope: PackageStateRecord["scope"];
    ownerId: string;
    packageName: string;
    collection: string;
    key: string;
  }): Promise<PackageStateRecord | null>;
  listByCollection(input: {
    scope: PackageStateRecord["scope"];
    ownerId: string;
    packageName: string;
    collection: string;
  }): Promise<PackageStateRecord[]>;
}

export interface JobRepository {
  save(record: JobRecord): Promise<void>;
  getById(id: string): Promise<JobRecord | null>;
  listBySessionId(sessionId: string): Promise<JobRecord[]>;
  listByStatus(status: JobRecord["status"]): Promise<JobRecord[]>;
}

export interface DomainRepositories {
  worlds: WorldRepository;
  sessions: SessionRepository;
  messages: MessageRepository;
  artifacts: ArtifactRepository;
  archiveVersions: ArchiveVersionRepository;
  memoryDocuments: MemoryDocumentRepository;
  retrievalRuns: RetrievalRunRepository;
  traceRecords: TraceRecordRepository;
}

export interface DomainRepositoriesWithPackageStateAndJobs {
  packageState: PackageStateRepository;
  jobs: JobRepository;
}
