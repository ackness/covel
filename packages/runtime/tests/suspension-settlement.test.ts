/**
 * The exits of a suspension (F-015, F-016, F-173, F-188): what a suspension
 * records, when a resume finds it out of date, and how abandoning one settles
 * the turn and the progress jobs it held back.
 */
import { describe, expect, it, vi } from "vitest";
import { createMemoryStore } from "@covel/store/memory";
import type { DataStore, SuspensionRecord } from "@covel/store";
import type { RuntimeManifest } from "@covel/shared";
import type { LoadedRuntime } from "@covel/shared/plugin-runtime";
import {
  applySuspensionAbandonTx,
  commitExecution,
  executeTurn,
  planSuspensionAbandon,
  resumeSuspendedRuntime,
  settleAbandonedSuspensionJobs,
  suspensionOutdatedReason,
} from "../src/index.js";

const timestamp = "2026-10-02T00:00:00.000Z";
const sessionId = "session";

const asker: RuntimeManifest = {
  description: "test",
  name: "probe/asker",
  pluginId: "probe",
  version: "1.2.0",
  runtimeType: "function",
  stage: "post-turn",
  outputKind: "plugin",
  trigger: { type: "auto" },
};
const notes: RuntimeManifest = {
  description: "test",
  name: "notes/extract",
  pluginId: "notes",
  runtimeType: "function",
  stage: "post-turn",
  outputKind: "plugin",
  trigger: { type: "auto" },
  turnCompletion: { mode: "detached" },
  effects: { writes: ["plugin-data:self:notes"] },
};

async function createSession(store: DataStore): Promise<void> {
  await store.createSession({
    id: sessionId,
    locale: "en-US",
    status: "active",
    phase: "playing",
    setupRuntimes: {},
    activePlugins: ["probe", "notes"],
    completedPlayerTurns: 0,
    createdAt: timestamp,
    updatedAt: timestamp,
  });
}

function deps(store: DataStore) {
  return {
    store,
    llm: { generate: vi.fn() },
    loadRuntime: async (manifest: RuntimeManifest): Promise<LoadedRuntime> => ({
      manifest,
      promptTemplate: "",
      handler: async (context) => {
        if (context.resumeData !== undefined)
          return { outcome: "success", value: { content: "Confirmed." } };
        // Report progress, then wait for the player.
        await context.progress?.report({
          jobId: "draft",
          state: "running",
          sequence: 1,
        });
        return {
          outcome: "suspended",
          reason: "Need player confirmation",
          resumeSchema: { type: "object" },
        };
      },
    }),
  };
}

/** Commit one player turn whose asker suspends; returns its suspension. */
async function suspendedTurn(
  store: DataStore,
  turn: string,
  runtimes: readonly RuntimeManifest[] = [asker, notes],
): Promise<SuspensionRecord> {
  const execution = await executeTurn(
    {
      sessionId,
      turnId: turn,
      logicalTurnId: `logical-${turn}`,
      playerMessage: "Ask the archivist",
      origin: "player",
    },
    runtimes,
    deps(store),
  );
  const outcome = await commitExecution({
    store,
    execution,
    completion: { kind: "turn", turnId: turn, durationMs: 0 },
  });
  expect(outcome.status).toBe("committed");
  const suspension = (await store.listSuspensions(sessionId)).find(
    (record) => record.turnId === turn,
  );
  expect(suspension).toBeDefined();
  return suspension!;
}

async function abandon(store: DataStore, suspension: SuspensionRecord) {
  const plan = await planSuspensionAbandon(store, suspension);
  await store.withTransaction((tx) =>
    applySuspensionAbandonTx(tx, plan, new Date().toISOString()),
  );
  await settleAbandonedSuspensionJobs({ store }, suspension);
  return plan;
}

async function draftStates(
  store: DataStore,
  suspension: SuspensionRecord,
): Promise<readonly string[]> {
  return (
    await store.listJobStatus(sessionId, {
      progressScopeId:
        suspension.pendingContinuation.executionContext.executionId,
      jobId: "draft",
    })
  ).map((record) => record.state);
}

describe("suspension basis", () => {
  it("records the player turns once the turn commits and the plugin version", async () => {
    const store = createMemoryStore();
    await createSession(store);
    const suspension = await suspendedTurn(store, "turn-1");
    expect(suspension.pendingContinuation.takenUnder).toEqual({
      playerTurns: 1,
      pluginVersion: "1.2.0",
    });
    expect(
      (await store.getTurnMessageStats(sessionId)).playerMessageCount,
    ).toBe(1);
    expect(
      await suspensionOutdatedReason(store, suspension, asker),
    ).toBeUndefined();
  });

  it("is out of date after a later player turn, a plugin update, or a newer suspension of the runtime", async () => {
    const store = createMemoryStore();
    await createSession(store);
    const first = await suspendedTurn(store, "turn-1");

    expect(
      await suspensionOutdatedReason(store, first, {
        ...asker,
        version: "2.0.0",
      }),
    ).toBe("plugin-updated");

    // The player plays on; the asker suspends again in the new turn.
    const second = await suspendedTurn(store, "turn-2");
    expect(await suspensionOutdatedReason(store, first, asker)).toBe(
      "session-moved-on",
    );
    expect(
      await suspensionOutdatedReason(store, second, asker),
    ).toBeUndefined();

    // Same history, but a newer suspension of the same runtime exists.
    await store.saveSuspension({
      ...second,
      id: "newer",
      createdAt: new Date(Date.parse(second.createdAt) + 1000).toISOString(),
    });
    expect(await suspensionOutdatedReason(store, second, asker)).toBe(
      "superseded",
    );
  });
});

describe("abandoning a suspension", () => {
  it("ends the turn when it was the last pending one: the turn counts and its held-back jobs are released", async () => {
    const store = createMemoryStore();
    await createSession(store);
    const suspension = await suspendedTurn(store, "turn-1");
    expect((await store.getSession(sessionId))?.completedPlayerTurns).toBe(0);

    const plan = await abandon(store, suspension);

    expect(plan.endsTurn).toBe(true);
    expect(plan.releasedRuntimeJobs.map((job) => job.runtimeId)).toEqual([
      notes.name,
    ]);
    expect(await store.getSuspension(suspension.id)).toBeNull();
    expect((await store.getSession(sessionId))?.completedPlayerTurns).toBe(1);
    expect(
      await store.getLogicalTurnCompletion(sessionId, "logical-turn-1"),
    ).not.toBeNull();
    // Abandoning again (a retry) never counts twice.
    await store.withTransaction((tx) =>
      applySuspensionAbandonTx(tx, plan, new Date().toISOString()),
    );
    expect((await store.getSession(sessionId))?.completedPlayerTurns).toBe(1);
  });

  it("leaves the turn to a sibling that still waits, including one claimed by a resume", async () => {
    const store = createMemoryStore();
    await createSession(store);
    const suspension = await suspendedTurn(store, "turn-1");
    const sibling: SuspensionRecord = {
      ...suspension,
      id: "sibling",
      runtimeId: "probe/other",
    };
    await store.saveSuspension(sibling);
    expect(await store.claimSuspension(sibling.id)).not.toBeNull();

    const plan = await abandon(store, suspension);

    expect(plan.endsTurn).toBe(false);
    expect(plan.releasedRuntimeJobs).toEqual([]);
    expect((await store.getSession(sessionId))?.completedPlayerTurns).toBe(0);
  });

  it("ends the progress jobs the suspended execution reported as cancelled", async () => {
    const store = createMemoryStore();
    await createSession(store);
    const suspension = await suspendedTurn(store, "turn-1", [asker]);
    expect(await draftStates(store, suspension)).toEqual([
      "running",
      "waiting-input",
    ]);

    await abandon(store, suspension);

    expect(await draftStates(store, suspension)).toEqual([
      "running",
      "waiting-input",
      "cancelled",
    ]);
  });
});

describe("resuming a suspension", () => {
  it("ends the suspended execution's progress jobs with the resume's commit", async () => {
    const store = createMemoryStore();
    await createSession(store);
    const suspension = await suspendedTurn(store, "turn-1", [asker]);
    expect(await store.claimSuspension(suspension.id)).not.toBeNull();

    const resumed = await resumeSuspendedRuntime(
      suspension,
      { ok: true },
      asker,
      deps(store),
    );
    expect(resumed.result.status).toBe("success");
    const outcome = await commitExecution({
      store,
      execution: resumed,
      completion: {
        kind: "resume",
        turnId: suspension.turnId,
        suspensionId: suspension.id,
        pluginId: asker.pluginId,
        runtimeId: asker.name,
      },
    });

    expect(outcome.status).toBe("committed");
    expect(await draftStates(store, suspension)).toEqual([
      "running",
      "waiting-input",
      "succeeded",
    ]);
  });
});
