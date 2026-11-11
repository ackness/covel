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
  TurnResult,
} from "@covel/shared";
import type { DataStore, SessionRecord } from "@covel/store";
import { createMemoryStore } from "@covel/store/memory";
import {
  CommitSessionGoneError,
  NO_FOLLOW_UPS,
  queueCommitFollowUps,
  queueFollowUpsWith,
  queueReleasedRuntimeJobs,
  refuseFollowUps,
  type CommitFollowUps,
  type FollowUpSource,
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

/** A committed result: two deferred stage jobs and one follower by default. */
function committed(overrides: Partial<FollowUpSource> = {}): FollowUpSource {
  return {
    turnId: "turn-1",
    runtimeResults: [result("narrator", [{ topic: TOPIC }]), result("sidebar")],
    deferredRuntimeJobs: [deferredJob("recap"), deferredJob("portrait")],
    deferredFollowers: [follower],
    ...overrides,
  };
}

function envelope(
  overrides: Partial<CommitFollowUps> = {},
  source: Partial<FollowUpSource> = {},
): CommitFollowUps {
  const turnResult = committed(source);
  return {
    sessionId: SESSION_ID,
    activeRuntimes,
    locale: "en-US",
    isolation: {
      droppedRuntimeIds: new Set(),
      droppedRunIds: new Set(),
      followerSources: (turnResult.deferredFollowers ?? []).map(
        () => "run-narrator",
      ),
    },
    turnResult,
    ...overrides,
  };
}

/** An envelope from an execution that deferred no stage jobs. */
function followersOnly(
  overrides: Partial<CommitFollowUps> = {},
  source: Partial<FollowUpSource> = {},
): CommitFollowUps {
  return envelope(overrides, { deferredRuntimeJobs: [], ...source });
}

const asTurnResult = (source: FollowUpSource) =>
  source as unknown as TurnResult;

describe("queueCommitFollowUps", () => {
  it("queues every deferred job and follower when nothing was dropped", async () => {
    const { store } = await setup();
    const queued = await store.withTransaction((tx) =>
      queueCommitFollowUps(tx, envelope()),
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
    const { store } = await setup();
    const queued = await store.withTransaction((tx) =>
      queueCommitFollowUps(
        tx,
        envelope({
          isolation: {
            droppedRuntimeIds: new Set(["sidebar"]),
            droppedRunIds: new Set(["run-sidebar"]),
            followerSources: ["run-narrator"],
          },
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
    const { store } = await setup();
    const queued = await store.withTransaction((tx) =>
      queueCommitFollowUps(
        tx,
        followersOnly({
          isolation: {
            droppedRuntimeIds: new Set(["narrator"]),
            droppedRunIds: new Set(["run-narrator"]),
            followerSources: ["run-narrator"],
          },
        }),
      ),
    );
    expect(queued).toEqual({ runtimeJobs: [], followerJobs: [] });
    expect(
      await listRuntimeJobs(store, { sessionId: SESSION_ID }),
    ).toHaveLength(0);
  });

  it.each([
    ["narrator", "run-narrator", "run-narrator", []],
    ["sidebar", "run-sidebar", "run-narrator", ["illustrator"]],
    ["narrator", "old-narrator-run", "new-narrator-run", ["illustrator"]],
  ] as const)(
    "filters followers when runtime %s drops run %s (producer=%s)",
    async (droppedRuntimeId, droppedRunId, producerRunId, expected) => {
      const { store } = await setup();
      const queued = await store.withTransaction((tx) =>
        queueCommitFollowUps(
          tx,
          followersOnly(
            {
              isolation: {
                droppedRuntimeIds: new Set([droppedRuntimeId]),
                droppedRunIds: new Set([droppedRunId]),
                followerSources: [producerRunId],
              },
            },
            {
              runtimeResults: [
                result("narrator", [{ topic: TOPIC }]),
                result("sidebar", [{ topic: TOPIC }]),
              ],
            },
          ),
        ),
      );
      expect(queued.followerJobs.map(({ job }) => job.runtimeId)).toEqual(
        expected,
      );
      await store.close();
    },
  );

  it("filters followers of an execution that deferred no stage jobs", async () => {
    // A manual or event run usually emits followers only. A sync run drops
    // nothing today; a simulated dropped emitter is still honoured.
    const { store } = await setup();
    const withoutDeferred = followersOnly({ sourceRuntimeId: "narrator" });
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
      queueCommitFollowUps(
        tx,
        followersOnly(
          {
            sourceRuntimeId: "narrator",
            isolation: {
              droppedRuntimeIds: new Set(["narrator"]),
              droppedRunIds: new Set(["run-narrator"]),
              followerSources: ["run-narrator"],
            },
          },
          { turnId: "turn-2" },
        ),
      ),
    );
    expect(dropped.followerJobs).toEqual([]);
  });

  it("queues nothing for empty inputs", async () => {
    const { store } = await setup();
    const queued = await store.withTransaction((tx) =>
      queueCommitFollowUps(
        tx,
        envelope({}, { deferredRuntimeJobs: [], deferredFollowers: [] }),
      ),
    );
    expect(queued).toEqual({ runtimeJobs: [], followerJobs: [] });
    expect(
      await listRuntimeJobs(store, { sessionId: SESSION_ID }),
    ).toHaveLength(0);
  });

  it("queues nothing when the commit transaction rolls back", async () => {
    const { store } = await setup();
    await expect(
      store.withTransaction(async (tx) => {
        await queueCommitFollowUps(tx, envelope());
        throw new Error("commit rolled back");
      }),
    ).rejects.toThrow("commit rolled back");
    expect(
      await listRuntimeJobs(store, { sessionId: SESSION_ID }),
    ).toHaveLength(0);
  });

  it("admits stage jobs under the session the transaction reads", async () => {
    const { store, session } = await setup();
    const queued = await store.withTransaction(async (tx) => {
      await tx.updateSession(SESSION_ID, {
        runtimeModelOverrides: { recap: "fast" },
        updatedAt: NOW,
      });
      return queueCommitFollowUps(tx, envelope({}, { deferredFollowers: [] }));
    });
    expect(session.runtimeModelOverrides).toBeUndefined();
    expect(queued.runtimeJobs[0]!.job.payload).toMatchObject({
      expectedSessionIncarnation: "incarnation:incarnation",
      runtimeModelOverrides: { recap: "fast" },
    });
  });

  it("fails the commit when the session is gone and stage jobs were deferred", async () => {
    const { store } = await setup();
    await store.deleteSession(SESSION_ID);
    // Even when every deferred job would be left out as dropped.
    await expect(
      store.withTransaction((tx) =>
        queueCommitFollowUps(
          tx,
          envelope(
            {
              isolation: {
                droppedRuntimeIds: new Set(["sidebar"]),
                droppedRunIds: new Set(["run-sidebar"]),
                followerSources: ["run-narrator"],
              },
            },
            {
              deferredRuntimeJobs: [deferredJob("recap")],
              deferredFollowers: [],
            },
          ),
        ),
      ),
    ).rejects.toThrow(CommitSessionGoneError);
    // Without stage jobs there is no session to admit them under.
    await expect(
      store.withTransaction((tx) =>
        queueCommitFollowUps(
          tx,
          envelope({}, { deferredRuntimeJobs: [], deferredFollowers: [] }),
        ),
      ),
    ).resolves.toEqual({ runtimeJobs: [], followerJobs: [] });
  });

  it("hands provider services to each stage job inside the transaction", async () => {
    const { store } = await setup();
    const registered: string[] = [];
    await store.withTransaction((tx) =>
      queueCommitFollowUps(
        tx,
        envelope({
          credentials: {
            register: ({ credentialKey }) => {
              registered.push(credentialKey.jobId);
            },
          },
        }),
      ),
    );
    // Followers are handed theirs once the commit landed, by the caller.
    expect(registered).toEqual(["job-recap", "job-portrait"]);
  });

  it("queues the followers given in place of the result's", async () => {
    const { store } = await setup();
    const queued = await store.withTransaction((tx) =>
      queueCommitFollowUps(tx, envelope({ followers: [] })),
    );
    expect(queued.runtimeJobs).toHaveLength(2);
    expect(queued.followerJobs).toEqual([]);
  });
});

describe("commit follow-up queues", () => {
  it("queue what a result derived under the host's context", async () => {
    const { store } = await setup();
    const queue = queueFollowUpsWith(
      { sessionId: SESSION_ID, activeRuntimes, locale: "en-US" },
      // An activation that failed chains no followers.
      () => [],
    );
    const queued = await store.withTransaction((tx) =>
      queue(tx, asTurnResult(committed()), {
        droppedRuntimeIds: new Set(),
        droppedRunIds: new Set(),
        followerSources: ["run-narrator"],
      }),
    );
    expect(queued.runtimeJobs.map(({ job }) => job.runtimeId)).toEqual([
      "recap",
      "portrait",
    ]);
    expect(queued.followerJobs).toEqual([]);
  });

  it("refuse, rolling the commit back, what a host cannot queue", async () => {
    const { store } = await setup();
    const isolation = {
      droppedRuntimeIds: new Set<string>(),
      droppedRunIds: new Set<string>(),
      followerSources: [],
    };
    for (const source of [
      committed({ deferredFollowers: [] }),
      committed({ deferredRuntimeJobs: [] }),
    ]) {
      await expect(
        store.withTransaction((tx) =>
          refuseFollowUps(tx, asTurnResult(source), isolation),
        ),
      ).rejects.toThrow("the host has no follow-up queue");
    }
    await expect(
      store.withTransaction((tx) =>
        refuseFollowUps(
          tx,
          asTurnResult(
            committed({ deferredRuntimeJobs: [], deferredFollowers: [] }),
          ),
          isolation,
        ),
      ),
    ).resolves.toBe(NO_FOLLOW_UPS);
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

it("filters repeated follower targets by invocation before narrowing overrides", async () => {
  const { store } = await setup();
  const first = {
    ...follower,
    triggerEvent: { topic: TOPIC, data: { invocation: 1 } },
  };
  const second = {
    ...follower,
    triggerEvent: { topic: TOPIC, data: { invocation: 2 } },
  };
  const args = followersOnly(
    {
      isolation: {
        droppedRuntimeIds: new Set(),
        droppedRunIds: new Set(["first-run"]),
        followerSources: ["first-run", "second-run"],
      },
      followers: [second],
    },
    { deferredFollowers: [first, second] },
  );
  const queued = await store.withTransaction((tx) =>
    queueCommitFollowUps(tx, args),
  );
  expect(queued.followerJobs).toHaveLength(1);
  expect(queued.followerJobs[0]!.job.payload).toMatchObject({
    triggerEvent: { data: { invocation: 2 } },
  });
  await store.close();
});

it("refuses a follower override rebuilt outside the emitted descriptor list", async () => {
  const { store } = await setup();
  await expect(
    store.withTransaction((tx) =>
      queueCommitFollowUps(tx, followersOnly({ followers: [{ ...follower }] })),
    ),
  ).rejects.toThrow("original emitted descriptors");
  await store.close();
});

it("refuses an unpaired follower producer list", async () => {
  const { store } = await setup();
  await expect(
    store.withTransaction((tx) =>
      queueCommitFollowUps(
        tx,
        followersOnly({
          isolation: {
            droppedRuntimeIds: new Set(),
            droppedRunIds: new Set(),
            followerSources: [],
          },
        }),
      ),
    ),
  ).rejects.toThrow("equal lengths");
  await store.close();
});
