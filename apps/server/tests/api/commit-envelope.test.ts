/**
 * Transactional queueing of eligible follow-ups and released jobs.
 */

import { describe, expect, it } from "vitest";
import type {
  DeferredRuntimeJob,
  RuntimeManifest,
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
      runtimeResults: [],
    },
    upstreamResults: [],
  };
}

const follower = {
  runtimeId: "illustrator",
  pluginId: PLUGIN_ID,
  triggerEvent: { topic: TOPIC, data: {} },
};

const turn: TurnResult = {
  turnId: "turn-1",
  sessionId: SESSION_ID,
  executionContext: {
    executionId: "execution-1",
    origin: "manual",
    countPolicy: "none",
  },
  runtimeResults: [],
  durationMs: 0,
  timestamp: NOW,
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

function envelope(overrides: Partial<CommitFollowUps> = {}): CommitFollowUps {
  return {
    sessionId: SESSION_ID,
    activeRuntimes,
    locale: "en-US",
    turnId: "turn-1",
    deferredRuntimeJobs: [deferredJob("recap"), deferredJob("portrait")],
    deferredFollowers: [follower],
    ...overrides,
  };
}

describe("queueCommitFollowUps", () => {
  it("queues eligible jobs and preserves their source", async () => {
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
    expect(queued.followerJobs[0]!.job.origin).toMatchObject({
      activation: "event",
      sourceTurnId: "turn-1",
    });
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
      return queueCommitFollowUps(tx, envelope({ deferredFollowers: [] }));
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
          envelope({ deferredRuntimeJobs: [], deferredFollowers: [] }),
        ),
      ),
    ).rejects.toThrow(CommitSessionGoneError);
    // Without stage jobs there is no session to admit them under.
    await expect(
      store.withTransaction((tx) =>
        queueCommitFollowUps(
          tx,
          envelope({ deferredRuntimeJobs: undefined, deferredFollowers: [] }),
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
});

describe("commit follow-up queues", () => {
  it("does not chain followers after a failed activation", async () => {
    const { store } = await setup();
    const queue = queueFollowUpsWith(
      { sessionId: SESSION_ID, activeRuntimes, locale: "en-US" },
      // An activation that failed chains no followers.
      () => true,
    );
    const queued = await store.withTransaction((tx) =>
      queue(tx, turn, {
        droppedRuntimeIds: new Set(),
        deferredRuntimeJobs: [deferredJob("recap"), deferredJob("portrait")],
        deferredFollowers: [follower],
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
      deferredFollowers: [],
    };
    for (const source of [
      { deferredRuntimeJobs: [deferredJob("recap")] },
      { deferredFollowers: [follower] },
    ]) {
      await expect(
        store.withTransaction((tx) =>
          refuseFollowUps(tx, { ...turn, ...source }, isolation),
        ),
      ).rejects.toThrow("the host has no follow-up queue");
    }
    await expect(
      store.withTransaction((tx) => refuseFollowUps(tx, turn, isolation)),
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
});
