/**
 * The work an execution queues inside its commit transaction: deferred stage
 * jobs and event followers, leaving out what builds on a runtime whose writes
 * were dropped, and the held-back jobs a suspended turn releases.
 */

import { describe, expect, it } from "vitest";
import type {
  DeferredRuntimeJob,
  RuntimeManifest,
  RuntimeResult,
} from "@covel/shared";
import type { DataStore, SessionRecord } from "@covel/store";
import { createMemoryStore } from "@covel/store/memory";
import {
  queueCommitFollowUps,
  queueReleasedRuntimeJobs,
  type CommitFollowUps,
} from "../../src/routes/api/commit-envelope.js";
import { listRuntimeJobs } from "../../src/routes/api/plugin-rpc/jobs.js";

const PLUGIN_ID = "envelope-probe";
const SESSION_ID = "envelope-session";
const NOW = "2026-11-09T00:00:00.000Z";
const TOPIC = "envelope-probe.ready";

function manifest(
  name: string,
  extra: Partial<RuntimeManifest> = {},
): RuntimeManifest {
  return {
    name,
    pluginId: PLUGIN_ID,
    description: "test function runtime",
    runtimeType: "function",
    outputKind: "system",
    handler: "./handler.js",
    trigger: { type: "auto" },
    ...extra,
  } as RuntimeManifest;
}

const narrator = manifest("narrator");
const sidebar = manifest("sidebar");
/** Hard-depends on `sidebar`. */
const recap = manifest("recap", { needs: ["sidebar"] });
/** Only orders after `sidebar`. */
const portrait = manifest("portrait", { after: ["sidebar"] });
const illustrator = manifest("illustrator", {
  trigger: { type: "event", topic: TOPIC },
});
const activeRuntimes = [narrator, sidebar, recap, portrait, illustrator];

function result(
  runtimeId: string,
  events: readonly { topic: string }[] = [],
): RuntimeResult {
  return {
    pluginId: PLUGIN_ID,
    runtimeId,
    runId: `run-${runtimeId}`,
    turnId: "turn-1",
    status: "success",
    output: {},
    ...(events.length > 0
      ? { effects: { events: events.map((e) => ({ ...e, data: {} })) } }
      : {}),
  } as RuntimeResult;
}

function deferredJob(runtimeId: string): DeferredRuntimeJob {
  return {
    jobId: `job-${runtimeId}`,
    runtimeId,
    pluginId: PLUGIN_ID,
    sourceTurnId: "turn-1",
    sourceExecutionId: "execution-1",
    sourceExecutionStartedAt: NOW,
    turnDigest: {
      turnId: "turn-1",
      playerMessage: "hello",
      actions: [],
      lastPlayerInput: null,
      narrativeText: "",
      toolCallSummaries: [],
      runtimeResults: [
        { runtimeId: "narrator", status: "success" },
        { runtimeId: "sidebar", status: "success" },
      ],
    },
    upstreamResults: [result("narrator"), result("sidebar")],
  };
}

const follower = {
  runtimeId: "illustrator",
  pluginId: PLUGIN_ID,
  triggerEvent: { topic: TOPIC, data: {} },
};

async function setup(): Promise<{
  store: DataStore;
  session: SessionRecord;
}> {
  const store = createMemoryStore();
  await store.createSession({
    id: SESSION_ID,
    worldId: "world",
    status: "active",
    phase: "playing",
    locale: "en-US",
    completedPlayerTurns: 1,
    setupRuntimes: {},
    seats: [
      { id: "main", controller: "human", role: "player", characters: "auto" },
    ],
    activePlugins: [PLUGIN_ID],
    metadata: {
      approvalScopeNonce: "approval",
      sessionIncarnationNonce: "incarnation",
    },
    createdAt: NOW,
    updatedAt: NOW,
  });
  return { store, session: (await store.getSession(SESSION_ID))! };
}

/** An envelope from a path that queues followers only. */
function followersOnly(
  session: SessionRecord,
  overrides: Partial<CommitFollowUps> = {},
): CommitFollowUps {
  const { deferred: _deferred, ...rest } = envelope(session, overrides);
  return rest;
}

function envelope(
  session: SessionRecord,
  overrides: Partial<CommitFollowUps> = {},
): CommitFollowUps {
  return {
    sessionId: SESSION_ID,
    activeRuntimes,
    locale: "en-US",
    isolation: { droppedRuntimeIds: new Set() },
    results: [result("narrator", [{ topic: TOPIC }]), result("sidebar")],
    sourceTurnId: "turn-1",
    deferred: {
      session,
      jobs: [deferredJob("recap"), deferredJob("portrait")],
    },
    followers: [follower],
    ...overrides,
  };
}

describe("queueCommitFollowUps", () => {
  it("queues every deferred job and follower when nothing was dropped", async () => {
    const { store, session } = await setup();
    const queued = await store.withTransaction((tx) =>
      queueCommitFollowUps(tx, envelope(session)),
    );
    expect(queued.runtimeJobs.map(({ job }) => job.runtimeId)).toEqual([
      "recap",
      "portrait",
    ]);
    expect(queued.followerJobs.map(({ job }) => job.runtimeId)).toEqual([
      "illustrator",
    ]);
    // Frozen inputs are untouched when nothing was dropped.
    const portraitJob = queued.runtimeJobs.find(
      ({ job }) => job.runtimeId === "portrait",
    )!.job;
    expect(
      (portraitJob.payload as { descriptor: DeferredRuntimeJob }).descriptor
        .upstreamResults,
    ).toMatchObject([
      { runtimeId: "narrator", status: "success" },
      { runtimeId: "sidebar", status: "success" },
    ]);
  });

  it("leaves out a deferred job that hard-depends on a dropped runtime and settles the others' inputs", async () => {
    const { store, session } = await setup();
    const queued = await store.withTransaction((tx) =>
      queueCommitFollowUps(
        tx,
        envelope(session, {
          isolation: { droppedRuntimeIds: new Set(["sidebar"]) },
        }),
      ),
    );
    expect(queued.runtimeJobs.map(({ job }) => job.runtimeId)).toEqual([
      "portrait",
    ]);
    const descriptor = (
      queued.runtimeJobs[0]!.job.payload as { descriptor: DeferredRuntimeJob }
    ).descriptor;
    expect(descriptor.turnDigest.runtimeResults).toEqual([
      { runtimeId: "narrator", status: "success" },
      { runtimeId: "sidebar", status: "failed" },
    ]);
    expect(descriptor.upstreamResults).toMatchObject([
      { runtimeId: "narrator", status: "success" },
      {
        runtimeId: "sidebar",
        status: "failed",
        error: "writes did not commit",
      },
    ]);
    // The narrator's event still committed: its follower is queued.
    expect(queued.followerJobs.map(({ job }) => job.runtimeId)).toEqual([
      "illustrator",
    ]);
  });

  it("leaves out a follower whose every emitter was dropped", async () => {
    const { store, session } = await setup();
    const queued = await store.withTransaction((tx) =>
      queueCommitFollowUps(
        tx,
        followersOnly(session, {
          isolation: { droppedRuntimeIds: new Set(["narrator"]) },
        }),
      ),
    );
    expect(queued).toEqual({ runtimeJobs: [], followerJobs: [] });
    expect(
      await listRuntimeJobs(store, { sessionId: SESSION_ID }),
    ).toHaveLength(0);
  });

  it("filters followers on a path that queues no deferred jobs", async () => {
    // Manual RPC and job-executor commits pass only followers. A sync run
    // drops nothing today; a simulated dropped emitter is still honoured.
    const { store, session } = await setup();
    const withoutDeferred = followersOnly(session, {
      sourceRuntimeId: "narrator",
    });
    const kept = await store.withTransaction((tx) =>
      queueCommitFollowUps(tx, withoutDeferred),
    );
    expect(kept.runtimeJobs).toEqual([]);
    expect(kept.followerJobs).toHaveLength(1);
    expect(kept.followerJobs[0]!.job.origin).toMatchObject({
      activation: "event",
      sourceTurnId: "turn-1",
      sourceRuntimeId: "narrator",
    });

    const dropped = await store.withTransaction((tx) =>
      queueCommitFollowUps(tx, {
        ...withoutDeferred,
        sourceTurnId: "turn-2",
        isolation: { droppedRuntimeIds: new Set(["narrator"]) },
      }),
    );
    expect(dropped.followerJobs).toEqual([]);
  });

  it("queues nothing for empty inputs", async () => {
    const { store, session } = await setup();
    const queued = await store.withTransaction((tx) =>
      queueCommitFollowUps(
        tx,
        envelope(session, {
          deferred: { session, jobs: [] },
          followers: [],
        }),
      ),
    );
    expect(queued).toEqual({ runtimeJobs: [], followerJobs: [] });
    expect(
      await listRuntimeJobs(store, { sessionId: SESSION_ID }),
    ).toHaveLength(0);
  });

  it("queues nothing when the commit transaction rolls back", async () => {
    const { store, session } = await setup();
    await expect(
      store.withTransaction(async (tx) => {
        await queueCommitFollowUps(tx, envelope(session));
        throw new Error("commit rolled back");
      }),
    ).rejects.toThrow("commit rolled back");
    expect(
      await listRuntimeJobs(store, { sessionId: SESSION_ID }),
    ).toHaveLength(0);
  });
});

describe("queueReleasedRuntimeJobs", () => {
  it("queues released jobs and skips those whose runtime left the active set", async () => {
    const { store, session } = await setup();
    const queued = await store.withTransaction((tx) =>
      queueReleasedRuntimeJobs(
        tx,
        {
          sessionId: SESSION_ID,
          session,
          activeRuntimes: [narrator, portrait],
          locale: "en-US",
        },
        [deferredJob("recap"), deferredJob("portrait")],
      ),
    );
    expect(queued.map(({ job }) => job.runtimeId)).toEqual(["portrait"]);
    expect(
      (await listRuntimeJobs(store, { sessionId: SESSION_ID })).map(
        (job) => job.runtimeId,
      ),
    ).toEqual(["portrait"]);
  });

  it("queues nothing for no released jobs", async () => {
    const { store, session } = await setup();
    const queued = await store.withTransaction((tx) =>
      queueReleasedRuntimeJobs(
        tx,
        {
          sessionId: SESSION_ID,
          session,
          activeRuntimes,
          locale: "en-US",
        },
        [],
      ),
    );
    expect(queued).toEqual([]);
  });
});
