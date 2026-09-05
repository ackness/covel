import { describe, expect, it } from "vitest";
import {
  BrowserSyncValidationError,
  validateBrowserCheckpoint,
  validateSessionCommit,
  type BrowserCheckpoint,
} from "../src/browser-sync/browser-sync.js";
import {
  createMemoryStore,
  exportSessionCheckpoint,
  replaceSessionFromCheckpoint,
} from "../src/index.js";
import {
  makeCharacter,
  makeEvent,
  makeInteractionRecord,
  makeJobStatus,
  makeLogicalTurnCompletion,
  makeLorebookEntry,
  makeMessage,
  makePlayerInput,
  makeRuntimeExport,
  makeRuntimeOutput,
  makeRuntimeResult,
  makeSession,
  makeSessionSummary,
  makeSetupAttempt,
  makeSnapshot,
  makeSnapshotPayload,
  makeStateChange,
  makeStateEntry,
  makeStateSchema,
  makeSuspension,
  makeToolCall,
  makeTraceEvent,
  makeTurnMessage,
  makeTurnResult,
  makeWorkingMemory,
  makeWorld,
  makeWorldDataImportLedger,
} from "../src/contract/test-fixtures.js";

const sessionId = "sess-1";
const timestamp = "2026-08-25T00:00:00.000Z";
const pluginData = {
  id: "plugin-data-1",
  sessionId,
  pluginId: "test-plugin",
  namespace: "test",
  key: "value",
  value: { sessionId: "opaque-business-data", ok: true },
  createdAt: timestamp,
  updatedAt: timestamp,
};
const snapshotRecords = {
  characters: [makeCharacter()],
  stateEntries: [makeStateEntry()],
  pluginData: [pluginData],
  workingMemory: [makeWorkingMemory()],
  sessionSummaries: [makeSessionSummary()],
  lorebookEntries: [makeLorebookEntry()],
  suspensions: [makeSuspension()],
};
const domainRecords = {
  messages: [makeMessage()],
  turnMessages: [makeTurnMessage()],
  turnResults: [makeTurnResult()],
  runtimeResults: [makeRuntimeResult()],
  toolCalls: [makeToolCall()],
  runtimeOutputs: [makeRuntimeOutput()],
  interactions: [makeInteractionRecord()],
  events: [makeEvent()],
  traceEvents: [makeTraceEvent()],
  characters: [makeCharacter()],
  pluginData: [pluginData],
  workingMemory: [makeWorkingMemory()],
  lorebookEntries: [makeLorebookEntry()],
  sessionSummaries: [makeSessionSummary()],
  playerInputs: [makePlayerInput()],
  suspensions: [makeSuspension()],
  snapshots: [makeSnapshot({ payload: makeSnapshotPayload(snapshotRecords) })],
  worldDataLedger: [makeWorldDataImportLedger()],
  logicalTurnLedger: [makeLogicalTurnCompletion()],
  setupAttempts: [makeSetupAttempt()],
  jobStatus: [makeJobStatus()],
  runtimeExports: [makeRuntimeExport()],
};
const stateRecords = {
  schemas: [makeStateSchema()],
  entries: [makeStateEntry()],
  changes: [makeStateChange()],
};
const checkpoint: BrowserCheckpoint = JSON.parse(
  JSON.stringify({
    schemaVersion: 2,
    sessionId,
    profile: "browser-private",
    session: makeSession({ id: sessionId }),
    world: makeWorld({ id: "world-1" }),
    ...domainRecords,
    state: stateRecords,
    revision: 1,
    actionId: "action-1",
    committedAt: timestamp,
  }),
) as BrowserCheckpoint;

describe("checkpoint record validation", () => {
  it("preserves valid records in every durable domain and opaque JSON", () => {
    expect(validateBrowserCheckpoint(checkpoint)).toEqual(checkpoint);
  });

  it.each(Object.keys(domainRecords) as (keyof typeof domainRecords)[])(
    "rejects foreign session ownership in %s",
    (domain) => {
      expect(() =>
        validateBrowserCheckpoint({
          ...checkpoint,
          [domain]: [
            { ...checkpoint[domain][0], sessionId: "another-session" },
          ],
        }),
      ).toThrow(`${domain}[0].sessionId must match checkpoint.sessionId`);
    },
  );

  it.each(Object.keys(domainRecords) as (keyof typeof domainRecords)[])(
    "rejects malformed records in %s",
    (domain) => {
      expect(() =>
        validateBrowserCheckpoint({
          ...checkpoint,
          [domain]: [{ sessionId }],
        }),
      ).toThrow(BrowserSyncValidationError);
      expect(() =>
        validateBrowserCheckpoint({
          ...checkpoint,
          [domain]: [null],
        }),
      ).toThrow(BrowserSyncValidationError);
    },
  );

  it.each(Object.keys(stateRecords) as (keyof typeof stateRecords)[])(
    "rejects foreign or malformed state.%s records",
    (domain) => {
      expect(() =>
        validateBrowserCheckpoint({
          ...checkpoint,
          state: {
            ...checkpoint.state,
            [domain]: [
              { ...stateRecords[domain][0], sessionId: "another-session" },
            ],
          },
        }),
      ).toThrow(`state.${domain}[0].sessionId must match checkpoint.sessionId`);
      expect(() =>
        validateBrowserCheckpoint({
          ...checkpoint,
          state: { ...checkpoint.state, [domain]: [{ sessionId }] },
        }),
      ).toThrow(BrowserSyncValidationError);
    },
  );

  it.each(Object.keys(snapshotRecords) as (keyof typeof snapshotRecords)[])(
    "rejects foreign or malformed snapshot payload %s records",
    (domain) => {
      const snapshot = checkpoint.snapshots[0]!;
      const nestedCheckpoint = (record: unknown) => ({
        ...checkpoint,
        snapshots: [
          {
            ...snapshot,
            payload: { ...snapshot.payload, [domain]: [record] },
          },
        ],
      });
      expect(() =>
        validateBrowserCheckpoint(
          nestedCheckpoint({
            ...snapshotRecords[domain][0],
            sessionId: "another-session",
          }),
        ),
      ).toThrow(
        `snapshots[0].payload.${domain}[0].sessionId must match checkpoint.sessionId`,
      );
      expect(() =>
        validateBrowserCheckpoint(nestedCheckpoint({ sessionId })),
      ).toThrow(BrowserSyncValidationError);
    },
  );

  it("keeps optional fields compatible with earlier schema-v3 snapshots", () => {
    const snapshot = checkpoint.snapshots[0]!;
    const { sessionSummaries: _, ...legacyPayload } = snapshot.payload;
    const legacyCheckpoint = {
      ...checkpoint,
      snapshots: [{ ...snapshot, payload: legacyPayload }],
    };
    expect(validateBrowserCheckpoint(legacyCheckpoint)).toEqual(
      legacyCheckpoint,
    );
  });

  it("validates non-identity fields and nested execution state", () => {
    expect(() =>
      validateBrowserCheckpoint({
        ...checkpoint,
        messages: [{ ...checkpoint.messages[0], content: 123 }],
      }),
    ).toThrow("messages[0].content");
    expect(() =>
      validateBrowserCheckpoint({
        ...checkpoint,
        pluginData: [{ ...pluginData, value: undefined }],
      }),
    ).toThrow("pluginData[0].value");
    expect(() =>
      validateBrowserCheckpoint({
        ...checkpoint,
        session: {
          ...checkpoint.session,
          setupRuntimes: { test: { state: "done" } },
        },
      }),
    ).toThrow("session.setupRuntimes.test");
    const suspension = checkpoint.suspensions[0]!;
    expect(() =>
      validateBrowserCheckpoint({
        ...checkpoint,
        suspensions: [
          {
            ...suspension,
            pendingContinuation: {
              ...suspension.pendingContinuation,
              messages: {},
            },
          },
        ],
      }),
    ).toThrow("suspensions[0].pendingContinuation.messages");
  });

  it("exports an in-flight suspension claim using the backend claim marker", async () => {
    const store = createMemoryStore();
    await store.createSession(checkpoint.session);
    const suspension = checkpoint.suspensions[0]!;
    await store.saveSuspension(suspension);
    expect(await store.claimSuspension(suspension.id)).toBe(true);
    const exported = await exportSessionCheckpoint(store, sessionId, {
      revision: 1,
      actionId: "claimed-suspension",
    });
    expect(exported.suspensions[0]?.resolvedAt).toMatch(/^claimed:/);
  });

  it("rejects malformed and unrelated worlds", () => {
    expect(() =>
      validateBrowserCheckpoint({ ...checkpoint, world: {} }),
    ).toThrow(BrowserSyncValidationError);
    expect(() =>
      validateBrowserCheckpoint({
        ...checkpoint,
        world: { ...checkpoint.world, id: "another-world" },
      }),
    ).toThrow("world.id must match session.worldId");
  });

  it("preserves locale maps in browser world documents", () => {
    const localizedCheckpoint = {
      ...checkpoint,
      world: {
        ...checkpoint.world,
        name: { "en-US": "Mistport", "zh-CN": "雾港" },
        description: { "en-US": "A port in fog", "zh-CN": "雾中港口" },
        lore: { "en-US": "Port lore", "zh-CN": "港口传说" },
      },
    };
    expect(validateBrowserCheckpoint(localizedCheckpoint)).toEqual(
      localizedCheckpoint,
    );
  });

  it("applies ownership validation to commit envelopes", () => {
    expect(() =>
      validateSessionCommit({
        baseRevision: 0,
        revision: 1,
        actionId: checkpoint.actionId,
        checkpoint: {
          ...checkpoint,
          pluginData: [{ ...pluginData, sessionId: "another-session" }],
        },
      }),
    ).toThrow("pluginData[0].sessionId must match checkpoint.sessionId");
  });

  it("exports historical fork payloads in the child scope without mutating stored history", async () => {
    const store = createMemoryStore();
    const childSessionId = "child-session";
    await store.createSession(checkpoint.session);
    await store.createSession(makeSession({ id: childSessionId }));
    const legacySnapshot = {
      ...checkpoint.snapshots[0]!,
      kind: "fork" as const,
      sessionId: childSessionId,
    };
    const parentSuspension = legacySnapshot.payload.suspensions[0]!;
    await store.saveSuspension(parentSuspension);
    await store.saveSnapshot(legacySnapshot);
    const exported = await exportSessionCheckpoint(store, childSessionId, {
      revision: 1,
      actionId: "legacy-fork",
    });

    for (const key of Object.keys(
      snapshotRecords,
    ) as (keyof typeof snapshotRecords)[]) {
      expect(
        exported.snapshots[0]!.payload[key]?.map((record) => record.sessionId),
      ).toEqual([childSessionId]);
    }
    expect(await store.getSnapshot(legacySnapshot.id)).toEqual(legacySnapshot);
    const reboundSuspension = exported.snapshots[0]!.payload.suspensions[0]!;
    expect(reboundSuspension.id).not.toBe(parentSuspension.id);
    const repeatedExport = await exportSessionCheckpoint(
      store,
      childSessionId,
      {
        revision: 1,
        actionId: "legacy-fork",
      },
    );
    expect(repeatedExport.snapshots[0]!.payload.suspensions[0]!.id).toBe(
      reboundSuspension.id,
    );
    await store.saveSuspension(reboundSuspension);
    expect(await store.getSuspension(parentSuspension.id)).toEqual(
      parentSuspension,
    );
    expect(() =>
      validateBrowserCheckpoint({
        ...exported,
        snapshots: [legacySnapshot],
      }),
    ).toThrow("must match checkpoint.sessionId");
  });

  it("rejects a foreign plugin-data write before replacing either session", async () => {
    const store = createMemoryStore();
    const ownSession = makeSession({ id: sessionId });
    const otherSession = makeSession({ id: "another-session" });
    await store.createSession(ownSession);
    await store.createSession(otherSession);
    const ownMessage = makeMessage({ sessionId });
    const otherData = { ...pluginData, sessionId: otherSession.id };
    await store.addMessage(ownMessage);
    await store.setPluginData(otherData);
    const ownCheckpoint = await exportSessionCheckpoint(store, sessionId, {
      revision: 1,
      actionId: "malicious-checkpoint",
    });

    await expect(
      replaceSessionFromCheckpoint(store, {
        ...ownCheckpoint,
        pluginData: [{ ...otherData, value: "overwritten" }],
      }),
    ).rejects.toThrow(BrowserSyncValidationError);

    expect(await store.getSession(sessionId)).toEqual(ownSession);
    expect(await store.getSession(otherSession.id)).toEqual(otherSession);
    expect(await store.listMessages(sessionId)).toEqual([ownMessage]);
    expect(await store.listPluginDataSessionScope(otherSession.id)).toEqual([
      otherData,
    ]);
  });
});
