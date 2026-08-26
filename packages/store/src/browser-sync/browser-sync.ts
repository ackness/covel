import { isJsonValue } from "@covel/shared";
import type {
  CharacterRecord,
  EventRecord,
  InteractionRecordRow,
  LorebookEntryRecord,
  MessageRecord,
  PluginDataRecord,
  PlayerInputRecord,
  RuntimeOutputRecord,
  RuntimeResultRecord,
  RuntimeExportRecord,
  SessionRecord,
  SessionSummaryRecord,
  SetupAttemptRecord,
  SnapshotRecord,
  StateChangeRecord,
  StateEntryRecord,
  StateSchemaRecord,
  SuspensionRecord,
  ToolCallRecordRow,
  TraceEventRecord,
  TurnMessageRecord,
  TurnResultRecord,
  WorkingMemoryRecord,
  WorldDataImportLedgerRecord,
  WorldRecord,
  JobStatusRecord,
  LogicalTurnLedgerRecord,
} from "../types.js";

/** Persistence targets supported by the browser-authoritative contract. */
export const PERSISTENCE_PROFILES = [
  "browser-private",
  "desktop",
  "cloud",
] as const;

export type PersistenceProfile = (typeof PERSISTENCE_PROFILES)[number];

/** Schema version of the browser checkpoint envelope. */
export const BROWSER_CHECKPOINT_SCHEMA_VERSION = 2 as const;

export type BrowserCheckpointSchemaVersion =
  typeof BROWSER_CHECKPOINT_SCHEMA_VERSION;

/** Optional state domain kept separate while the state API is still evolving. */
export interface BrowserCheckpointState {
  readonly schemas: ReadonlyArray<StateSchemaRecord>;
  readonly entries: ReadonlyArray<StateEntryRecord>;
  readonly changes: ReadonlyArray<StateChangeRecord>;
}

/**
 * A JSON-safe, versioned snapshot of all durable session domains.
 *
 * The explicit domain arrays keep this contract independent from a concrete
 * DataStore implementation while retaining the existing record shapes. The
 * optional `state` member is intentionally isolated so it can be removed in a
 * later state-contract cleanup without reshaping the other domains.
 */
export interface BrowserCheckpoint {
  readonly schemaVersion: BrowserCheckpointSchemaVersion;
  readonly sessionId: string;
  readonly profile: PersistenceProfile;
  readonly session: SessionRecord;
  readonly world: WorldRecord | null;
  readonly messages: ReadonlyArray<MessageRecord>;
  readonly turnMessages: ReadonlyArray<TurnMessageRecord>;
  readonly turnResults: ReadonlyArray<TurnResultRecord>;
  readonly runtimeResults: ReadonlyArray<RuntimeResultRecord>;
  readonly toolCalls: ReadonlyArray<ToolCallRecordRow>;
  readonly runtimeOutputs: ReadonlyArray<RuntimeOutputRecord>;
  readonly interactions: ReadonlyArray<InteractionRecordRow>;
  readonly events: ReadonlyArray<EventRecord>;
  readonly traceEvents: ReadonlyArray<TraceEventRecord>;
  readonly characters: ReadonlyArray<CharacterRecord>;
  readonly pluginData: ReadonlyArray<PluginDataRecord>;
  readonly workingMemory: ReadonlyArray<WorkingMemoryRecord>;
  readonly lorebookEntries: ReadonlyArray<LorebookEntryRecord>;
  readonly sessionSummaries: ReadonlyArray<SessionSummaryRecord>;
  readonly playerInputs: ReadonlyArray<PlayerInputRecord>;
  readonly suspensions: ReadonlyArray<SuspensionRecord>;
  readonly snapshots: ReadonlyArray<SnapshotRecord>;
  readonly worldDataLedger: ReadonlyArray<WorldDataImportLedgerRecord>;
  readonly logicalTurnLedger: ReadonlyArray<LogicalTurnLedgerRecord>;
  readonly setupAttempts: ReadonlyArray<SetupAttemptRecord>;
  readonly jobStatus: ReadonlyArray<JobStatusRecord>;
  readonly runtimeExports: ReadonlyArray<RuntimeExportRecord>;
  readonly state?: BrowserCheckpointState;
  readonly revision: number;
  readonly actionId: string;
  readonly committedAt: string;
}

/** A client commit envelope carrying the base and target checkpoint revisions. */
export interface SessionCommit {
  readonly baseRevision: number;
  readonly revision: number;
  readonly actionId: string;
  readonly checkpoint: BrowserCheckpoint;
}

export class BrowserSyncValidationError extends Error {
  readonly code = "browser_sync_validation";

  constructor(message: string) {
    super(message);
    this.name = "BrowserSyncValidationError";
  }
}

export class RevisionConflictError extends Error {
  readonly code = "revision_conflict";

  constructor(
    readonly sessionId: string,
    readonly expectedRevision: number,
    readonly actualRevision: number,
  ) {
    super(
      `Revision conflict for session ${sessionId}: expected base revision ${expectedRevision}, received ${actualRevision}`,
    );
    this.name = "RevisionConflictError";
  }
}

export class ActionIdConflictError extends Error {
  readonly code = "action_id_conflict";

  constructor(
    readonly sessionId: string,
    readonly actionId: string,
  ) {
    super(
      `Action id ${actionId} was already committed for session ${sessionId}`,
    );
    this.name = "ActionIdConflictError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new BrowserSyncValidationError(`${label} must be an object`);
  }
  return value;
}

function requireNonEmptyString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new BrowserSyncValidationError(`${label} must be a non-empty string`);
  }
  return value;
}

function requireRevision(value: unknown, label: string, minimum = 1): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum) {
    throw new BrowserSyncValidationError(
      `${label} must be a safe integer greater than or equal to ${minimum}`,
    );
  }
  return value as number;
}

function requireCommittedAt(value: unknown): string {
  const committedAt = requireNonEmptyString(value, "committedAt");
  if (!Number.isFinite(Date.parse(committedAt))) {
    throw new BrowserSyncValidationError(
      "committedAt must be a valid timestamp",
    );
  }
  return committedAt;
}

function requireArray<T>(value: unknown, label: string): ReadonlyArray<T> {
  if (!Array.isArray(value)) {
    throw new BrowserSyncValidationError(`${label} must be an array`);
  }
  return value as ReadonlyArray<T>;
}

function requireOptionalState(
  value: unknown,
): BrowserCheckpointState | undefined {
  if (value === undefined) return undefined;
  const state = requireRecord(value, "state");
  return {
    schemas: requireArray<StateSchemaRecord>(state.schemas, "state.schemas"),
    entries: requireArray<StateEntryRecord>(state.entries, "state.entries"),
    changes: requireArray<StateChangeRecord>(state.changes, "state.changes"),
  };
}

const SESSION_PHASES = ["setup", "playing"] as const;
const SESSION_STATUSES = ["active", "paused", "ended"] as const;
const EXECUTION_ORIGINS = [
  "player",
  "continuation",
  "manual",
  "background",
  "recursive",
  "resume",
] as const;
const COMMIT_STATUSES = ["pending", "committed", "failed"] as const;

function requireEnum<T extends string>(
  value: unknown,
  allowed: readonly T[],
  label: string,
): T {
  if (typeof value !== "string" || !allowed.includes(value as T)) {
    throw new BrowserSyncValidationError(
      `${label} must be one of: ${allowed.join(", ")}`,
    );
  }
  return value as T;
}

function requireStringArray(value: unknown, label: string): readonly string[] {
  const array = requireArray<unknown>(value, label);
  if (!array.every((item) => typeof item === "string")) {
    throw new BrowserSyncValidationError(`${label} must contain only strings`);
  }
  return array as readonly string[];
}

function validateSessionClock(
  session: Record<string, unknown>,
  label: string,
): void {
  requireEnum(session.phase, SESSION_PHASES, `${label}.phase`);
  requireRevision(
    session.completedPlayerTurns,
    `${label}.completedPlayerTurns`,
    0,
  );
  requireRecord(session.setupRuntimes, `${label}.setupRuntimes`);
}

function validateSessionRecord(
  session: Record<string, unknown>,
  sessionId: string,
): SessionRecord {
  const recordId = requireNonEmptyString(session.id, "session.id");
  if (recordId !== sessionId) {
    throw new BrowserSyncValidationError(
      "session.id must match checkpoint.sessionId",
    );
  }
  requireEnum(session.status, SESSION_STATUSES, "session.status");
  validateSessionClock(session, "session");
  requireStringArray(session.activePlugins, "session.activePlugins");
  requireNonEmptyString(session.locale, "session.locale");
  requireCommittedAt(session.createdAt);
  requireCommittedAt(session.updatedAt);
  return session as unknown as SessionRecord;
}

function validateTurnResults(value: unknown): readonly TurnResultRecord[] {
  const results = requireArray<unknown>(value, "turnResults");
  results.forEach((value, index) => {
    const result = requireRecord(value, `turnResults[${index}]`);
    requireEnum(
      result.origin,
      EXECUTION_ORIGINS,
      `turnResults[${index}].origin`,
    );
    requireEnum(
      result.commitStatus,
      COMMIT_STATUSES,
      `turnResults[${index}].commitStatus`,
    );
  });
  return results as readonly TurnResultRecord[];
}

function validateExecutionContext(value: unknown, label: string): void {
  const context = requireRecord(value, label);
  requireNonEmptyString(context.executionId, `${label}.executionId`);
  requireEnum(context.origin, EXECUTION_ORIGINS, `${label}.origin`);
  requireEnum(
    context.countPolicy,
    ["none", "complete-player-turn"] as const,
    `${label}.countPolicy`,
  );
}

function validateSuspensions(
  value: unknown,
  label = "suspensions",
): readonly SuspensionRecord[] {
  const suspensions = requireArray<unknown>(value, label);
  suspensions.forEach((value, index) => {
    const suspension = requireRecord(value, `${label}[${index}]`);
    const continuation = requireRecord(
      suspension.pendingContinuation,
      `${label}[${index}].pendingContinuation`,
    );
    validateExecutionContext(
      continuation.executionContext,
      `${label}[${index}].pendingContinuation.executionContext`,
    );
  });
  return suspensions as readonly SuspensionRecord[];
}

function validateSnapshots(value: unknown): readonly SnapshotRecord[] {
  const snapshots = requireArray<unknown>(value, "snapshots");
  snapshots.forEach((value, index) => {
    const snapshot = requireRecord(value, `snapshots[${index}]`);
    requireEnum(
      snapshot.kind,
      ["auto", "manual", "fork"] as const,
      `snapshots[${index}].kind`,
    );
    const payload = requireRecord(
      snapshot.payload,
      `snapshots[${index}].payload`,
    );
    if (payload.schemaVersion !== 3) {
      throw new BrowserSyncValidationError(
        `snapshots[${index}].payload.schemaVersion must be 3`,
      );
    }
    validateSessionClock(
      requireRecord(payload.session, `snapshots[${index}].payload.session`),
      `snapshots[${index}].payload.session`,
    );
    validateSuspensions(
      payload.suspensions,
      `snapshots[${index}].payload.suspensions`,
    );
  });
  return snapshots as readonly SnapshotRecord[];
}

export function isPersistenceProfile(
  value: unknown,
): value is PersistenceProfile {
  return (
    typeof value === "string" &&
    (PERSISTENCE_PROFILES as readonly string[]).includes(value)
  );
}

export function assertPersistenceProfile(
  value: unknown,
): asserts value is PersistenceProfile {
  if (!isPersistenceProfile(value)) {
    throw new BrowserSyncValidationError(
      `profile must be one of: ${PERSISTENCE_PROFILES.join(", ")}`,
    );
  }
}

function requireProfile(value: unknown): PersistenceProfile {
  assertPersistenceProfile(value);
  return value;
}

/** Validate and narrow an unknown value received from storage or a wire. */
export function validateBrowserCheckpoint(value: unknown): BrowserCheckpoint {
  const checkpoint = requireRecord(value, "checkpoint");
  if (checkpoint.schemaVersion !== BROWSER_CHECKPOINT_SCHEMA_VERSION) {
    throw new BrowserSyncValidationError(
      `schemaVersion must be ${BROWSER_CHECKPOINT_SCHEMA_VERSION}`,
    );
  }

  const sessionId = requireNonEmptyString(checkpoint.sessionId, "sessionId");
  const profile = requireProfile(checkpoint.profile);
  const session = requireRecord(checkpoint.session, "session");
  const sessionRecord = validateSessionRecord(session, sessionId);
  const world =
    checkpoint.world === null ? null : requireRecord(checkpoint.world, "world");
  const revision = requireRevision(checkpoint.revision, "revision");
  const actionId = requireNonEmptyString(checkpoint.actionId, "actionId");
  const committedAt = requireCommittedAt(checkpoint.committedAt);
  const state = requireOptionalState(checkpoint.state);

  const normalized: BrowserCheckpoint = {
    schemaVersion: BROWSER_CHECKPOINT_SCHEMA_VERSION,
    sessionId,
    profile,
    session: sessionRecord,
    world: world as WorldRecord | null,
    messages: requireArray<MessageRecord>(checkpoint.messages, "messages"),
    turnMessages: requireArray<TurnMessageRecord>(
      checkpoint.turnMessages,
      "turnMessages",
    ),
    turnResults: validateTurnResults(checkpoint.turnResults),
    runtimeResults: requireArray<RuntimeResultRecord>(
      checkpoint.runtimeResults,
      "runtimeResults",
    ),
    toolCalls: requireArray<ToolCallRecordRow>(
      checkpoint.toolCalls,
      "toolCalls",
    ),
    runtimeOutputs: requireArray<RuntimeOutputRecord>(
      checkpoint.runtimeOutputs,
      "runtimeOutputs",
    ),
    interactions: requireArray<InteractionRecordRow>(
      checkpoint.interactions,
      "interactions",
    ),
    events: requireArray<EventRecord>(checkpoint.events, "events"),
    traceEvents: requireArray<TraceEventRecord>(
      checkpoint.traceEvents,
      "traceEvents",
    ),
    characters: requireArray<CharacterRecord>(
      checkpoint.characters,
      "characters",
    ),
    pluginData: requireArray<PluginDataRecord>(
      checkpoint.pluginData,
      "pluginData",
    ),
    workingMemory: requireArray<WorkingMemoryRecord>(
      checkpoint.workingMemory,
      "workingMemory",
    ),
    lorebookEntries: requireArray<LorebookEntryRecord>(
      checkpoint.lorebookEntries,
      "lorebookEntries",
    ),
    sessionSummaries: requireArray<SessionSummaryRecord>(
      checkpoint.sessionSummaries,
      "sessionSummaries",
    ),
    playerInputs: requireArray<PlayerInputRecord>(
      checkpoint.playerInputs,
      "playerInputs",
    ),
    suspensions: validateSuspensions(checkpoint.suspensions),
    snapshots: validateSnapshots(checkpoint.snapshots),
    worldDataLedger: requireArray<WorldDataImportLedgerRecord>(
      checkpoint.worldDataLedger,
      "worldDataLedger",
    ),
    logicalTurnLedger: requireArray<LogicalTurnLedgerRecord>(
      checkpoint.logicalTurnLedger,
      "logicalTurnLedger",
    ),
    setupAttempts: requireArray<SetupAttemptRecord>(
      checkpoint.setupAttempts,
      "setupAttempts",
    ),
    jobStatus: requireArray<JobStatusRecord>(checkpoint.jobStatus, "jobStatus"),
    runtimeExports: requireArray<RuntimeExportRecord>(
      checkpoint.runtimeExports,
      "runtimeExports",
    ),
    ...(state === undefined ? {} : { state }),
    revision,
    actionId,
    committedAt,
  };

  if (!isJsonValue(normalized)) {
    throw new BrowserSyncValidationError(
      "checkpoint domains must contain JSON-serialisable values",
    );
  }
  return normalized;
}

export function assertBrowserCheckpoint(
  value: unknown,
): asserts value is BrowserCheckpoint {
  validateBrowserCheckpoint(value);
}

export function isBrowserCheckpoint(
  value: unknown,
): value is BrowserCheckpoint {
  try {
    validateBrowserCheckpoint(value);
    return true;
  } catch {
    return false;
  }
}

/** Validate and narrow an unknown client commit. */
export function validateSessionCommit(value: unknown): SessionCommit {
  const commit = requireRecord(value, "commit");
  const baseRevision = requireRevision(commit.baseRevision, "baseRevision", 0);
  const revision = requireRevision(commit.revision, "revision");
  const actionId = requireNonEmptyString(commit.actionId, "actionId");
  const checkpoint = validateBrowserCheckpoint(commit.checkpoint);

  if (revision !== baseRevision + 1) {
    throw new BrowserSyncValidationError(
      "revision must equal baseRevision + 1",
    );
  }
  if (checkpoint.revision !== revision || checkpoint.actionId !== actionId) {
    throw new BrowserSyncValidationError(
      "checkpoint revision and actionId must match the commit metadata",
    );
  }

  return { baseRevision, revision, actionId, checkpoint };
}

export function assertSessionCommit(
  value: unknown,
): asserts value is SessionCommit {
  validateSessionCommit(value);
}

export function isSessionCommit(value: unknown): value is SessionCommit {
  try {
    validateSessionCommit(value);
    return true;
  } catch {
    return false;
  }
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableJson(item)).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(object[key])}`)
      .join(",")}}`;
  }
  const serialized = JSON.stringify(value);
  if (serialized === undefined) {
    throw new Error("Cannot serialize a non-JSON value");
  }
  return serialized;
}

function sameCheckpoint(
  left: BrowserCheckpoint,
  right: BrowserCheckpoint,
): boolean {
  return stableJson(left) === stableJson(right);
}

/**
 * Apply a validated commit without mutating either input.
 *
 * A repeated identical action is idempotent. Reusing an action id for a
 * different checkpoint is rejected, and every new action must use the current
 * revision as its base and advance the checkpoint by exactly one.
 */
export function applySessionCommit(
  current: BrowserCheckpoint | null,
  commit: SessionCommit,
): BrowserCheckpoint {
  const next = validateSessionCommit(commit);
  const previous = current === null ? null : validateBrowserCheckpoint(current);
  const sessionId = next.checkpoint.sessionId;

  if (previous === null) {
    if (next.baseRevision !== 0) {
      throw new RevisionConflictError(sessionId, 0, next.baseRevision);
    }
    return next.checkpoint;
  }

  if (
    previous.sessionId !== next.checkpoint.sessionId ||
    previous.profile !== next.checkpoint.profile
  ) {
    throw new BrowserSyncValidationError(
      "commit sessionId and profile must match the current checkpoint",
    );
  }

  if (previous.actionId === next.actionId) {
    if (
      next.baseRevision === previous.revision - 1 &&
      sameCheckpoint(previous, next.checkpoint)
    ) {
      return previous;
    }
    throw new ActionIdConflictError(sessionId, next.actionId);
  }

  if (next.baseRevision !== previous.revision) {
    throw new RevisionConflictError(
      sessionId,
      previous.revision,
      next.baseRevision,
    );
  }

  return next.checkpoint;
}
