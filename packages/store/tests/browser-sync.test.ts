import { describe, expect, it } from "vitest";
import {
  ActionIdConflictError,
  BROWSER_CHECKPOINT_SCHEMA_VERSION,
  BrowserSyncValidationError,
  RevisionConflictError,
  applySessionCommit,
  isBrowserCheckpoint,
  isPersistenceProfile,
  isSessionCommit,
  validateBrowserCheckpoint,
  validateSessionCommit,
} from "../src/browser-sync/browser-sync.js";
import type {
  BrowserCheckpoint,
  SessionCommit,
} from "../src/browser-sync/browser-sync.js";

const firstCheckpoint: BrowserCheckpoint = {
  schemaVersion: BROWSER_CHECKPOINT_SCHEMA_VERSION,
  sessionId: "session-1",
  profile: "browser-private",
  session: {
    id: "session-1",
    worldId: "world-1",
    status: "active",
    locale: "en-US",
    activePlugins: [],
    createdAt: "2026-08-25T00:00:00.000Z",
    updatedAt: "2026-08-25T00:00:00.000Z",
    phase: "playing",
    completedPlayerTurns: 1,
    setupRuntimes: {},
  },
  world: null,
  messages: [],
  turnMessages: [],
  turnResults: [],
  runtimeResults: [],
  toolCalls: [],
  runtimeOutputs: [],
  interactions: [],
  events: [],
  traceEvents: [],
  characters: [],
  pluginData: [],
  workingMemory: [],
  lorebookEntries: [],
  sessionSummaries: [],
  playerInputs: [],
  suspensions: [],
  snapshots: [],
  worldDataLedger: [],
  logicalTurnLedger: [],
  setupAttempts: [],
  jobStatus: [],
  runtimeExports: [],
  revision: 1,
  actionId: "action-1",
  committedAt: "2026-08-25T00:00:00.000Z",
};

function commitFrom(
  checkpoint: BrowserCheckpoint,
  baseRevision = checkpoint.revision - 1,
): SessionCommit {
  return {
    baseRevision,
    revision: checkpoint.revision,
    actionId: checkpoint.actionId,
    checkpoint,
  };
}

describe("browser-authoritative persistence contract", () => {
  it("validates profiles, checkpoints, and commit metadata", () => {
    expect(isPersistenceProfile("cloud")).toBe(true);
    expect(isPersistenceProfile("browser-shared")).toBe(false);
    expect(isBrowserCheckpoint(firstCheckpoint)).toBe(true);

    const commit = commitFrom(firstCheckpoint);
    expect(isSessionCommit(commit)).toBe(true);
    expect(() =>
      validateSessionCommit({
        ...commit,
        checkpoint: { ...firstCheckpoint, revision: 2 },
      }),
    ).toThrow(BrowserSyncValidationError);
  });

  it("rejects malformed checkpoint versions and domains", () => {
    expect(() =>
      validateBrowserCheckpoint({ ...firstCheckpoint, schemaVersion: 1 }),
    ).toThrow(BrowserSyncValidationError);
    expect(() =>
      validateBrowserCheckpoint({ ...firstCheckpoint, messages: undefined }),
    ).toThrow(BrowserSyncValidationError);
    expect(() =>
      validateBrowserCheckpoint({
        ...firstCheckpoint,
        session: { ...firstCheckpoint.session, phase: undefined },
      }),
    ).toThrow("session.phase must be one of");
    expect(() =>
      validateBrowserCheckpoint({
        ...firstCheckpoint,
        turnResults: [{ origin: "follower", commitStatus: "committed" }],
      }),
    ).toThrow("turnResults[0].origin must be one of");
  });

  it("accepts the first commit and advances revisions without mutation", () => {
    const commit = commitFrom(firstCheckpoint);
    const applied = applySessionCommit(null, commit);

    expect(applied).toEqual(firstCheckpoint);
    expect(commit).toEqual(commitFrom(firstCheckpoint));
  });

  it("makes an identical action idempotent and detects changed action reuse", () => {
    const duplicate = applySessionCommit(
      firstCheckpoint,
      commitFrom(firstCheckpoint),
    );
    expect(duplicate).toEqual(firstCheckpoint);

    const changed = {
      ...firstCheckpoint,
      messages: [{ id: "message-1" }],
    } as BrowserCheckpoint;
    expect(() =>
      applySessionCommit(firstCheckpoint, commitFrom(changed)),
    ).toThrow(ActionIdConflictError);
  });

  it("requires the current revision as the base for a new action", () => {
    const stale = {
      ...firstCheckpoint,
      actionId: "action-2",
      revision: 1,
    };
    expect(() =>
      applySessionCommit(firstCheckpoint, commitFrom(stale, 0)),
    ).toThrow(RevisionConflictError);
    expect(() =>
      applySessionCommit(firstCheckpoint, commitFrom(stale, 0)),
    ).toThrow("expected base revision 1, received 0");
  });
});
