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
  outputKind: "system",
  trigger: { type: "auto" },
};
const notes: RuntimeManifest = {
  description: "test",
  name: "notes/extract",
  pluginId: "notes",
  runtimeType: "function",
  stage: "post-turn",
  outputKind: "system",
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
    seats: [
      { id: "main", controller: "human", role: "player", characters: "auto" },
    ],
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

/** A runtime that buffers a write to its own data, then waits for the player. */
const writer: RuntimeManifest = {
  ...asker,
  name: "probe/writer",
  effects: { writes: ["plugin-data:self:quest"] },
};

function writerDeps(store: DataStore) {
  return {
    ...deps(store),
    loadRuntime: async (manifest: RuntimeManifest): Promise<LoadedRuntime> => ({
      manifest,
      promptTemplate: "",
      handler: async (context) => {
        if (context.resumeData !== undefined)
          return { outcome: "success", value: { content: "Confirmed." } };
        await context.pluginData?.set("quest", "stage", { step: "asked" });
        return {
          outcome: "suspended",
          reason: "Need player confirmation",
          resumeSchema: { type: "object" },
        };
      },
    }),
  };
}

function questRow(key: string, value: unknown) {
  const now = new Date().toISOString();
  return {
    id: `${sessionId}:probe:quest:${key}`,
    sessionId,
    pluginId: "probe",
    namespace: "quest",
    key,
    value,
    createdAt: now,
    updatedAt: now,
  };
}

/** Commit one player turn whose asker suspends; returns its suspension. */
async function suspendedTurn(
  store: DataStore,
  turn: string,
  runtimes: readonly RuntimeManifest[] = [asker, notes],
  makeDeps: (store: DataStore) => ReturnType<typeof deps> = deps,
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
    makeDeps(store),
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
      writes: [],
    });
    expect(
      (await store.getTurnMessageStats(sessionId)).playerMessageCount,
    ).toBe(1);
    expect(
      await suspensionOutdatedReason(store, suspension, asker),
    ).toBeUndefined();
  });

  it("is out of date after a later player turn or a plugin update", async () => {
    const store = createMemoryStore();
    await createSession(store);
    const first = await suspendedTurn(store, "turn-1");

    expect(
      await suspensionOutdatedReason(store, first, {
        ...asker,
        version: "2.0.0",
      }),
    ).toBe("plugin-updated");

    // The player plays on.
    await store.appendTurnMessage({
      id: "player-2",
      sessionId,
      turnId: "turn-2",
      sourceType: "player",
      role: "user",
      content: "Walk on",
      order: 0,
      createdAt: new Date().toISOString(),
    });
    expect(await suspensionOutdatedReason(store, first, asker)).toBe(
      "session-moved-on",
    );
  });

  it("records what its buffered writes would overwrite, and is out of date once one of them changed", async () => {
    const store = createMemoryStore();
    await createSession(store);
    await store.setPluginData(questRow("stage", { step: "start" }));
    const suspension = await suspendedTurn(
      store,
      "turn-1",
      [writer],
      writerDeps,
    );
    const writes = suspension.pendingContinuation.takenUnder.writes;
    expect(writes.map((write) => write.target)).toEqual([
      {
        kind: "plugin-data",
        pluginId: "probe",
        namespace: "quest",
        key: "stage",
      },
    ]);
    expect(writes[0]!.digest).toMatch(/^[0-9a-f]{64}$/);
    // Read before the buffered write landed: the value the player saw.
    expect(
      (await store.getPluginData(sessionId, "probe", "quest", "stage"))?.value,
    ).toEqual({ step: "start" });

    // A write to another key leaves it current.
    await store.setPluginData(questRow("log", ["met the archivist"]));
    expect(
      await suspensionOutdatedReason(store, suspension, writer),
    ).toBeUndefined();

    // A background job or a manual run writes the same key.
    await store.setPluginData(questRow("stage", { step: "background" }));
    expect(await suspensionOutdatedReason(store, suspension, writer)).toBe(
      "data-changed",
    );
  });
});

describe("one pending suspension per runtime", () => {
  async function suspendAgain(
    store: DataStore,
    enqueueReleasedJobsInTx?: Parameters<
      typeof commitExecution
    >[0]["enqueueReleasedJobsInTx"],
  ) {
    const execution = await executeTurn(
      {
        sessionId,
        turnId: "manual-2",
        logicalTurnId: "logical-manual-2",
        playerMessage: "",
        origin: "manual",
        manualTrigger: { runtimeId: asker.name },
      },
      [asker],
      deps(store),
    );
    return commitExecution({
      store,
      execution,
      completion: { kind: "turn", turnId: "manual-2", durationMs: 0 },
      ...(enqueueReleasedJobsInTx ? { enqueueReleasedJobsInTx } : {}),
    });
  }

  it("voids the older one when a new one is saved, settled like an abandon", async () => {
    const store = createMemoryStore();
    await createSession(store);
    const first = await suspendedTurn(store, "turn-1");
    const released: string[] = [];

    const outcome = await suspendAgain(store, async (_tx, jobs) => {
      released.push(...jobs.map((job) => job.runtimeId));
    });

    expect(outcome.status).toBe("committed");
    const pending = await store.listSuspensions(sessionId);
    expect(pending.map((record) => record.turnId)).toEqual(["manual-2"]);
    expect(await store.getSuspension(first.id)).toBeNull();
    // The older one ended its turn: it counts and its held-back job is queued.
    expect((await store.getSession(sessionId))?.completedPlayerTurns).toBe(1);
    expect(released).toEqual([notes.name]);
    expect(await draftStates(store, first)).toEqual([
      "running",
      "waiting-input",
      "cancelled",
    ]);
  });

  it("rolls the new one back rather than lose jobs it cannot queue", async () => {
    const store = createMemoryStore();
    await createSession(store);
    const first = await suspendedTurn(store, "turn-1");

    const outcome = await suspendAgain(store);

    expect(outcome.status).toBe("failed");
    const pending = await store.listSuspensions(sessionId);
    expect(pending.map((record) => record.id)).toEqual([first.id]);
    expect((await store.getSession(sessionId))?.completedPlayerTurns).toBe(0);
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

describe("resuming after what it writes changed (F-016)", () => {
  /** A runtime of the same plugin that writes `quest/<key>` when it runs. */
  function editor(key: string, overrides: Partial<RuntimeManifest> = {}) {
    const manifest: RuntimeManifest = {
      description: "test",
      name: `probe/edit-${key}`,
      pluginId: "probe",
      version: "1.2.0",
      runtimeType: "function",
      stage: "post-turn",
      outputKind: "system",
      trigger: { type: "manual" },
      effects: { writes: ["plugin-data:self:quest"] },
      ...overrides,
    };
    const runDeps = (store: DataStore) => ({
      ...deps(store),
      loadRuntime: async (m: RuntimeManifest): Promise<LoadedRuntime> => ({
        manifest: m,
        promptTemplate: "",
        handler: async (context) => {
          await context.pluginData?.set("quest", key, { step: m.name });
          return { outcome: "success", value: { ok: true } };
        },
      }),
    });
    return { manifest, runDeps };
  }

  async function manualRun(store: DataStore, key: string) {
    const { manifest, runDeps } = editor(key);
    const execution = await executeTurn(
      {
        sessionId,
        turnId: `manual-${key}`,
        logicalTurnId: `logical-manual-${key}`,
        playerMessage: "",
        origin: "manual",
        manualTrigger: { runtimeId: manifest.name },
      },
      [manifest],
      runDeps(store),
    );
    const outcome = await commitExecution({
      store,
      execution,
      completion: { kind: "turn", turnId: `manual-${key}`, durationMs: 0 },
    });
    expect(outcome.status).toBe("committed");
  }

  /** A detached job queued by an earlier turn finishes after the suspension. */
  async function backgroundJob(store: DataStore, key: string) {
    const { manifest, runDeps } = editor(key, {
      name: "probe/bookkeeper",
      trigger: { type: "auto" },
      turnCompletion: { mode: "detached" },
    });
    const execution = await executeTurn(
      {
        sessionId,
        turnId: "job-turn",
        playerMessage: "",
        origin: "background",
        detachedStage: {
          jobId: "job-1",
          runtimeId: manifest.name,
          sourceTurnId: "turn-0",
          sourceExecutionId: "execution-0",
          turnDigest: {
            turnId: "turn-0",
            playerMessage: "",
            lastPlayerInput: null,
            narrativeText: "",
            toolCallSummaries: [],
            runtimeResults: [],
          },
          sourceExecutionStartedAt: timestamp,
          sourceLogicalTurnId: "logical-turn-0",
          sourceLogicalTurn: 1,
          upstreamResults: [],
        },
      },
      [manifest],
      runDeps(store),
    );
    expect(execution.result.runtimeResults[0]?.status).toBe("success");
    const outcome = await commitExecution({
      store,
      execution,
      completion: { kind: "detached", turnId: "job-turn" },
    });
    expect(outcome.status).toBe("committed");
  }

  async function resume(
    store: DataStore,
    suspension: SuspensionRecord,
    makeDeps: (store: DataStore) => ReturnType<typeof deps> = writerDeps,
  ) {
    expect(await store.claimSuspension(suspension.id)).not.toBeNull();
    const resumed = await resumeSuspendedRuntime(
      suspension,
      { ok: true },
      writer,
      makeDeps(store),
    );
    expect(resumed.result.status).toBe("success");
    return commitExecution({
      store,
      execution: resumed,
      completion: {
        kind: "resume",
        turnId: suspension.turnId,
        suspensionId: suspension.id,
        pluginId: writer.pluginId,
        runtimeId: writer.name,
      },
    });
  }

  const stage = async (store: DataStore) =>
    (await store.getPluginData(sessionId, "probe", "quest", "stage"))?.value;

  it("refuses the commit when a background job wrote the same key", async () => {
    const store = createMemoryStore();
    await createSession(store);
    const suspension = await suspendedTurn(
      store,
      "turn-1",
      [writer],
      writerDeps,
    );
    await backgroundJob(store, "stage");

    expect(await suspensionOutdatedReason(store, suspension, writer)).toBe(
      "data-changed",
    );
    const outcome = await resume(store, suspension);

    expect(outcome.status).toBe("failed");
    expect(outcome.code).toBe("suspension-data-changed");
    expect(await stage(store)).toEqual({ step: "probe/bookkeeper" });
  });

  it("refuses the commit when a manual run wrote the same key", async () => {
    const store = createMemoryStore();
    await createSession(store);
    const suspension = await suspendedTurn(
      store,
      "turn-1",
      [writer],
      writerDeps,
    );
    await manualRun(store, "stage");

    const outcome = await resume(store, suspension);

    expect(outcome.code).toBe("suspension-data-changed");
    expect(await stage(store)).toEqual({ step: "probe/edit-stage" });
    // Nothing of the resume landed: the suspension still waits for its exit.
    expect((await store.getSuspension(suspension.id))?.resolvedAt).toMatch(
      /^claimed:/,
    );
  });

  it("compares again inside the commit, after the continuation ran", async () => {
    const store = createMemoryStore();
    await createSession(store);
    const suspension = await suspendedTurn(
      store,
      "turn-1",
      [writer],
      writerDeps,
    );
    expect(
      await suspensionOutdatedReason(store, suspension, writer),
    ).toBeUndefined();
    // The key changes while the resumed runtime runs.
    const racing = (target: DataStore) => ({
      ...writerDeps(target),
      loadRuntime: async (m: RuntimeManifest): Promise<LoadedRuntime> => ({
        manifest: m,
        promptTemplate: "",
        handler: async () => {
          await target.setPluginData(questRow("stage", { step: "racer" }));
          return { outcome: "success", value: { content: "Confirmed." } };
        },
      }),
    });

    const outcome = await resume(store, suspension, racing);

    expect(outcome.code).toBe("suspension-data-changed");
    expect(await stage(store)).toEqual({ step: "racer" });
  });

  it("commits when only another key changed", async () => {
    const store = createMemoryStore();
    await createSession(store);
    const suspension = await suspendedTurn(
      store,
      "turn-1",
      [writer],
      writerDeps,
    );
    await manualRun(store, "log");

    const outcome = await resume(store, suspension);

    expect(outcome.status).toBe("committed");
    expect(await stage(store)).toEqual({ step: "asked" });
    expect(
      (await store.getSuspension(suspension.id))?.resolvedAt,
    ).toBeDefined();
  });
});
