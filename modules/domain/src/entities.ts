export interface World {
  id: string;
  name: string;
  description: string;
  createdAt: Date;
}

export type TaskBindings = Record<string, string>;

export const STORY_NARRATION_TASK = "story.narration";

export interface Session {
  id: string;
  worldId: string;
  status: "active" | "waiting_for_input" | "archived";
  presetId?: string;
  taskBindings?: TaskBindings;
  createdAt: Date;
}

export interface Message {
  id: string;
  sessionId: string;
  role: "system" | "user" | "assistant";
  content: string;
  createdAt: Date;
}

export interface Artifact {
  id: string;
  sessionId: string;
  kind: string;
  uri: string;
  mediaType: string;
  createdAt: Date;
}

export interface ArchiveVersion {
  id: string;
  sessionId: string;
  turnCutoff: number;
  stateSnapshot: Record<string, unknown>;
  workingSummary: string;
  archiveSummary: string;
  createdAt: Date;
}

export interface MemoryDocument {
  id: string;
  sourceType: string;
  scope: string;
  title: string;
  content: string;
  metadata: Record<string, unknown>;
  provenance: Record<string, unknown>;
}

export interface RetrievalRun {
  id: string;
  sessionId: string;
  query: string;
  rewrittenQueries: string[];
  selectedSources: string[];
  candidates: string[];
  selectedChunks: string[];
  critique: string;
  latencyMs: number;
}

export interface TraceRecord {
  traceId: string;
  spanId: string;
  sessionId: string;
  turnId: string;
  component: string;
  eventType: string;
  payload: Record<string, unknown>;
  createdAt: Date;
}

export interface PackageStateRecord {
  scope: "world" | "session";
  ownerId: string;
  packageName: string;
  collection: string;
  key: string;
  value: Record<string, unknown>;
  updatedAt: Date;
}

export interface JobRecord {
  id: string;
  packageName: string;
  jobType: string;
  sessionId?: string;
  status: "queued" | "running" | "completed" | "failed";
  input: Record<string, unknown>;
  output?: Record<string, unknown>;
  error?: string;
  attempt: number;
  createdAt: Date;
  startedAt?: Date;
  completedAt?: Date;
}

const SESSION_STATUSES = new Set<Session["status"]>([
  "active",
  "waiting_for_input",
  "archived"
]);

const MESSAGE_ROLES = new Set<Message["role"]>([
  "system",
  "user",
  "assistant"
]);

const JOB_STATUSES = new Set<JobRecord["status"]>([
  "queued",
  "running",
  "completed",
  "failed"
]);

function assertNonEmptyString(value: string, label: string, entity: string): void {
  if (value.trim().length === 0) {
    throw new Error(`${entity} invariant failed: ${label} must be a non-empty string.`);
  }
}

function assertValidDate(value: Date, label: string, entity: string): void {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    throw new Error(`${entity} invariant failed: ${label} must be a valid date.`);
  }
}

function assertNonNegativeNumber(value: number, label: string, entity: string): void {
  if (value < 0) {
    throw new Error(`${entity} invariant failed: ${label} must be non-negative.`);
  }
}

function assertNonEmptyObject(
  value: Record<string, unknown>,
  label: string,
  entity: string
): void {
  if (Object.keys(value).length === 0) {
    throw new Error(`${entity} invariant failed: ${label} must not be empty.`);
  }
}

export function createWorld(props: World): World {
  assertNonEmptyString(props.id, "id", "world");
  assertNonEmptyString(props.name, "name", "world");
  assertValidDate(props.createdAt, "createdAt", "world");

  return { ...props };
}

export function createSession(props: Session): Session {
  assertNonEmptyString(props.id, "id", "session");
  assertNonEmptyString(props.worldId, "worldId", "session");
  assertValidDate(props.createdAt, "createdAt", "session");

  if (!SESSION_STATUSES.has(props.status)) {
    throw new Error("session invariant failed: status is unsupported.");
  }

  if (props.taskBindings) {
    for (const [task, presetId] of Object.entries(props.taskBindings)) {
      assertNonEmptyString(task, "taskBindings.task", "session");
      assertNonEmptyString(presetId, "taskBindings.presetId", "session");
    }
  }

  return { ...props };
}

export function createMessage(props: Message): Message {
  assertNonEmptyString(props.id, "id", "message");
  assertNonEmptyString(props.sessionId, "sessionId", "message");
  assertNonEmptyString(props.content, "content", "message");
  assertValidDate(props.createdAt, "createdAt", "message");

  if (!MESSAGE_ROLES.has(props.role)) {
    throw new Error("message invariant failed: role is unsupported.");
  }

  return { ...props };
}

export function createArtifact(props: Artifact): Artifact {
  assertNonEmptyString(props.id, "id", "artifact");
  assertNonEmptyString(props.sessionId, "sessionId", "artifact");
  assertNonEmptyString(props.kind, "kind", "artifact");
  assertNonEmptyString(props.uri, "uri", "artifact");
  assertNonEmptyString(props.mediaType, "mediaType", "artifact");
  assertValidDate(props.createdAt, "createdAt", "artifact");

  return { ...props };
}

export function createArchiveVersion(props: ArchiveVersion): ArchiveVersion {
  assertNonEmptyString(props.id, "id", "archive");
  assertNonEmptyString(props.sessionId, "sessionId", "archive");
  assertNonNegativeNumber(props.turnCutoff, "turnCutoff", "archive");
  assertNonEmptyString(props.workingSummary, "workingSummary", "archive");
  assertNonEmptyString(props.archiveSummary, "archiveSummary", "archive");
  assertValidDate(props.createdAt, "createdAt", "archive");

  return { ...props };
}

export function createMemoryDocument(props: MemoryDocument): MemoryDocument {
  assertNonEmptyString(props.id, "id", "memory");
  assertNonEmptyString(props.sourceType, "sourceType", "memory");
  assertNonEmptyString(props.scope, "scope", "memory");
  assertNonEmptyString(props.title, "title", "memory");
  assertNonEmptyString(props.content, "content", "memory");
  assertNonEmptyObject(props.provenance, "provenance", "memory");

  return { ...props };
}

export function createRetrievalRun(props: RetrievalRun): RetrievalRun {
  assertNonEmptyString(props.id, "id", "retrieval");
  assertNonEmptyString(props.sessionId, "sessionId", "retrieval");
  assertNonEmptyString(props.query, "query", "retrieval");
  assertNonNegativeNumber(props.latencyMs, "latencyMs", "retrieval");

  return { ...props };
}

export function createTraceRecord(props: TraceRecord): TraceRecord {
  assertNonEmptyString(props.traceId, "traceId", "trace");
  assertNonEmptyString(props.spanId, "spanId", "trace");
  assertNonEmptyString(props.sessionId, "sessionId", "trace");
  assertNonEmptyString(props.turnId, "turnId", "trace");
  assertNonEmptyString(props.component, "component", "trace");
  assertNonEmptyString(props.eventType, "eventType", "trace");
  assertValidDate(props.createdAt, "createdAt", "trace");

  return { ...props };
}

export function createPackageStateRecord(props: PackageStateRecord): PackageStateRecord {
  assertNonEmptyString(props.ownerId, "ownerId", "package-state");
  assertNonEmptyString(props.packageName, "packageName", "package-state");
  assertNonEmptyString(props.collection, "collection", "package-state");
  assertNonEmptyString(props.key, "key", "package-state");
  assertValidDate(props.updatedAt, "updatedAt", "package-state");

  if (props.scope !== "world" && props.scope !== "session") {
    throw new Error("package-state invariant failed: scope is unsupported.");
  }

  return { ...props };
}

export function createJobRecord(props: JobRecord): JobRecord {
  assertNonEmptyString(props.id, "id", "job");
  assertNonEmptyString(props.packageName, "packageName", "job");
  assertNonEmptyString(props.jobType, "jobType", "job");
  assertValidDate(props.createdAt, "createdAt", "job");
  assertNonNegativeNumber(props.attempt, "attempt", "job");

  if (!JOB_STATUSES.has(props.status)) {
    throw new Error("job invariant failed: status is unsupported.");
  }

  if (props.startedAt) {
    assertValidDate(props.startedAt, "startedAt", "job");
  }

  if (props.completedAt) {
    assertValidDate(props.completedAt, "completedAt", "job");
  }

  return { ...props };
}
