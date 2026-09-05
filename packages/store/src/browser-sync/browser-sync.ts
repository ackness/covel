import { isJsonValue } from "@covel/shared";
import { checkpointDomainsSchema } from "./checkpoint-domains-schema.js";
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
  const domains = checkpointDomainsSchema.safeParse(checkpoint);
  if (!domains.success) {
    const issue = domains.error.issues[0]!;
    const path = issue.path.reduce<string>(
      (label, key) =>
        typeof key === "number"
          ? `${label}[${key}]`
          : `${label}${label ? "." : ""}${String(key)}`,
      "",
    );
    throw new BrowserSyncValidationError(`${path} ${issue.message}`);
  }
  if (domains.data.session.id !== sessionId) {
    throw new BrowserSyncValidationError(
      "session.id must match checkpoint.sessionId",
    );
  }
  const revision = requireRevision(checkpoint.revision, "revision");
  const actionId = requireNonEmptyString(checkpoint.actionId, "actionId");
  const committedAt = requireCommittedAt(checkpoint.committedAt);
  const normalized: BrowserCheckpoint = {
    schemaVersion: BROWSER_CHECKPOINT_SCHEMA_VERSION,
    sessionId,
    profile,
    ...domains.data,
    // Browser worlds retain localized text beyond the historical store type;
    // the client resolves those fields before uploading a server checkpoint.
    world: domains.data.world as WorldRecord | null,
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
