import { afterEach, describe, expect, it, vi } from "vitest";
import { executeTurn } from "../src/turn-executor/turn-executor.js";
import { createEventBus, type EventBus } from "@covel/events";
import { createMemoryStore } from "@covel/store/memory";
import { createSqliteStore } from "@covel/store/sqlite";
import type { DataStore } from "@covel/store";
import {
  DIMENSION_CONTRACT,
  DIMENSION_DATA_NAMESPACE,
  DIMENSION_SETTLEMENT_NAMESPACE,
  dimensionSnapshotFromRecords,
  type DimensionRecord,
  type Proposal,
  type RuntimeManifest,
} from "@covel/shared";
import { registerDimensionSettlements } from "../src/commit/dimension-finalization.js";
import { finalizeExecution } from "../src/commit/finalize-execution.js";
import { createHookPipeline } from "../src/hooks/pipeline.js";
import { createCommitPipeline } from "../src/session/session-kernel.js";
import { dimensionExecutionBarrier } from "../src/turn-executor/dimension-barrier.js";
import { createWorldModelView } from "../src/function-runtime/world-model-view.js";
import { buildSessionSnapshot } from "../src/snapshot/snapshot-builder.js";

const at = "2026-10-02T00:00:00.000Z";
const definition = {
  name: "Reputation",
  schema: { type: "integer" as const, minimum: 0, maximum: 100 },
  initialValue: 0,
  updateRule: "Completed commissions add five.",
};
const initial: DimensionRecord = { definition, value: 0, version: 1 };
const runtimes = [
  {
    name: "owner/context",
    pluginId: "owner",
    outputKind: "system",
    outputContract: DIMENSION_CONTRACT,
  },
  { name: "story", pluginId: "story", outputKind: "story" },
  { name: "owner/tracker", pluginId: "owner", outputKind: "system" },
] as RuntimeManifest[];
const open: DataStore[] = [];
afterEach(async () => {
  await Promise.all(open.splice(0).map((store) => store.close()));
});
async function setup(create = createMemoryStore) {
  const store = create();
  open.push(store);
  await store.createSession({
    id: "s",
    status: "active",
    phase: "playing",
    completedPlayerTurns: 0,
    setupRuntimes: {},
    activePlugins: ["owner", "story"],
    metadata: { _dimensionProviderPluginId: "owner" },
    locale: "en-US",
    createdAt: at,
    updatedAt: at,
  });
  await store.compareAndSetPluginDataBatch("s", "owner", [
    {
      namespace: DIMENSION_DATA_NAMESPACE,
      key: "reputation",
      expectedVersion: null,
      value: initial,
      timestamp: at,
    },
  ]);
  return store;
}
function proposal(payload: unknown, type = "dimension.update"): Proposal {
  return {
    id: crypto.randomUUID(),
    type,
    source: { pluginId: "owner", runtimeId: "owner/tracker" },
    sessionId: "s",
    turnId: "t",
    timestamp: at,
    payload,
  } as Proposal;
}
function tracked(value?: number) {
  return proposal({
    source: { resultId: "narrative-result", turnNumber: 1 },
    readVersions: { reputation: 1 },
    updates:
      value === undefined
        ? []
        : [{ id: "reputation", expectedVersion: 1, value }],
    ...(value === undefined ? { settlement: "no-change" } : {}),
  });
}
async function finalize(
  store: DataStore,
  update?: Proposal | readonly Proposal[],
  options: {
    trackerStatus?: string;
    irStatus?: string;
    records?: Record<string, DimensionRecord>;
    eventBus?: EventBus;
  } = {},
) {
  await store.saveTurnResult({
    id: "artifact",
    sessionId: "s",
    turnId: "t",
    origin: "player",
    runtimeResults: [],
    commitStatus: "pending",
    durationMs: 1,
    createdAt: at,
  });
  const result = (
    runtimeId: string,
    pluginId: string,
    output: Record<string, unknown>,
    status = "success",
  ) => ({
    runtimeId,
    pluginId,
    runId: runtimeId === "story" ? "narrative-result" : runtimeId,
    turnId: "t",
    status,
    output,
  });
  return finalizeExecution({
    store,
    ...(options.eventBus ? { eventBus: options.eventBus } : {}),
    sessionId: "s",
    turnIds: ["t"],
    executionContext: {
      executionId: "execution",
      origin: "player",
      countPolicy: "complete-player-turn",
      logicalTurnId: "logical",
    },
    runtimes: [
      ...runtimes,
      ...(options.irStatus
        ? [
            {
              name: "facts",
              pluginId: "facts",
              outputKind: "system",
              outputContract: "world-ir-provider@1",
            },
          ]
        : []),
    ],
    results: [
      result(
        "owner/context",
        "owner",
        dimensionSnapshotFromRecords(
          options.records ?? { reputation: initial },
        ),
      ),
      result("story", "story", {
        narrativeOutput: "The commission was completed.",
      }),
      {
        ...result("owner/tracker", "owner", {}, options.trackerStatus),
        pendingProposals: update
          ? Array.isArray(update)
            ? update
            : [update]
          : [],
      },
      ...(options.irStatus
        ? [result("facts", "facts", {}, options.irStatus)]
        : []),
    ],
  });
}
const record = async (store: DataStore) =>
  (
    await store.getPluginData(
      "s",
      "owner",
      DIMENSION_DATA_NAMESPACE,
      "reputation",
    )
  )?.value as DimensionRecord;
const receipt = async (store: DataStore) =>
  (
    await store.getPluginData(
      "s",
      "owner",
      DIMENSION_SETTLEMENT_NAMESPACE,
      "narrative-result",
    )
  )?.value as Record<string, unknown> | undefined;

for (const [backend, create] of [
  ["memory", createMemoryStore],
  ["sqlite", () => createSqliteStore(":memory:")],
] as const) {
  describe(`dimension finalization: ${backend}`, () => {
    it("commits story, values, frozen definitions and receipt together; source retries are deduplicated", async () => {
      const store = await setup(create);
      expect((await finalize(store, tracked(5))).status).toBe("committed");
      expect(await record(store)).toMatchObject({ value: 5, version: 2 });
      expect(await receipt(store)).toMatchObject({
        status: "settled",
        definitions: {},
        readVersions: {},
      });
      expect(await receipt(store)).not.toHaveProperty("narrative");
      expect(
        (await buildSessionSnapshot(store, "s"))?.dimensions.reputation?.value,
      ).toBe(5);
      expect(
        (await buildSessionSnapshot(store, "s"))?.dimensions.reputation,
      ).not.toHaveProperty("initialValue");
      const repeated = await createCommitPipeline(store).commitAll([
        tracked(5),
      ]);
      expect(repeated.every((entry) => entry.committed)).toBe(true);
      expect(await record(store)).toMatchObject({ value: 5, version: 2 });
      expect(await receipt(store)).toMatchObject({
        status: "settled",
        version: 2,
      });
    });
    it("records the settlement event once when it is published", async () => {
      const store = await setup(create);
      const eventBus = createEventBus(store);
      const failures = vi.spyOn(console, "error");
      await finalize(store, undefined, { eventBus });
      await eventBus.flush();
      expect(
        (await store.listEvents("s")).filter(
          (event) =>
            (event.payload as { _subType?: string })._subType ===
            "dimensions.settlement.changed",
        ),
      ).toHaveLength(1);
      expect(failures).not.toHaveBeenCalled();
      failures.mockRestore();
      await eventBus.close();
    });

    it("registers obligations when initialization and narrative share one commit", async () => {
      const store = await setup(create);
      await store.deletePluginData(
        "s",
        "owner",
        DIMENSION_DATA_NAMESPACE,
        "reputation",
      );
      expect(
        (
          await finalize(
            store,
            [
              proposal(
                { definitions: { reputation: definition } },
                "dimension.initialize",
              ),
              tracked(5),
            ],
            { records: {} },
          )
        ).status,
      ).toBe("committed");
      expect(await record(store)).toMatchObject({ value: 5, version: 2 });
      expect(await receipt(store)).toMatchObject({
        status: "settled",
        definitions: {},
      });
    });
    it("records explicit no-change without incrementing the value version", async () => {
      const store = await setup(create);
      expect((await finalize(store, tracked())).status).toBe("committed");
      expect(await receipt(store)).toMatchObject({ status: "no-change" });
      expect(await record(store)).toMatchObject({ value: 0, version: 1 });
    });
    it.each(["failed", "skipped", "success"])(
      "registers debt even when tracker is %s or never submits a proposal",
      async (trackerStatus) => {
        const store = await setup(create);
        expect(
          (await finalize(store, undefined, { trackerStatus })).status,
        ).toBe("committed");
        expect(await receipt(store)).toMatchObject({
          status: "pending-settlement",
        });
        expect(
          (await store.listMessages("s")).some((message) =>
            message.content.includes("commission"),
          ),
        ).toBe(true);
        expect(
          await dimensionExecutionBarrier({
            store,
            sessionId: "s",
            runtimes,
            willNarrate: true,
          }),
        ).toContain("pending");
        expect(
          await dimensionExecutionBarrier({
            store,
            sessionId: "s",
            runtimes,
            willNarrate: false,
          }),
        ).toBeUndefined();
      },
    );
    it.each([5, undefined])(
      "keeps a player correction on stale updates/no-change, while committing the story",
      async (value) => {
        const store = await setup(create);
        await store.compareAndSetPluginDataBatch("s", "owner", [
          {
            namespace: DIMENSION_DATA_NAMESPACE,
            key: "reputation",
            expectedVersion: 1,
            value: { ...initial, value: 42, version: 2 },
            timestamp: at,
          },
        ]);
        expect((await finalize(store, tracked(value))).status).toBe(
          "committed",
        );
        expect(await record(store)).toMatchObject({ value: 42, version: 2 });
        // Stale read set surfaces as pending-settlement; the authoritative
        // records-first baseline makes the receipt carry the post-correction
        // version, so the stale update is rejected at the read-set check rather
        // than the value CAS. Either pending reason is correct — assert the
        // terminal state, not a specific message.
        expect(await receipt(store)).toMatchObject({
          status: "pending-settlement",
        });
        expect((await receipt(store))?.error).toBeTruthy();
        expect((await store.listMessages("s")).length).toBe(1);
      },
    );
    it.each(["manual", "skipped"])(
      "allows explicit %s recovery after restart without an automatic success receipt",
      async (settlement) => {
        const store = await setup(create);
        await finalize(store, undefined, { trackerStatus: "failed" });
        const result = await createCommitPipeline(store).commitAll([
          proposal({
            source: { resultId: "narrative-result", turnNumber: 1 },
            readVersions: { reputation: 1 },
            updates: [],
            settlement,
          }),
        ]);
        expect(result.every((entry) => entry.committed)).toBe(true);
        expect(await receipt(store)).toMatchObject({ status: settlement });
        expect(
          await dimensionExecutionBarrier({
            store,
            sessionId: "s",
            runtimes,
            willNarrate: true,
          }),
        ).toBeUndefined();
      },
    );
    it("cannot turn failed shared extraction into a no-change receipt", async () => {
      const store = await setup(create);
      expect(
        (await finalize(store, tracked(), { irStatus: "failed" })).status,
      ).toBe("committed");
      expect(await receipt(store)).toMatchObject({
        status: "pending-settlement",
        error: "Shared WorldIR extraction failed",
      });
    });
    it("keeps invalid rule output as pending, never a schema-invalid value", async () => {
      const store = await setup(create);
      expect((await finalize(store, tracked(101))).status).toBe("committed");
      expect(await receipt(store)).toMatchObject({
        status: "pending-settlement",
      });
      expect(await record(store)).toMatchObject({ value: 0, version: 1 });
    });
    it("drops only the tracker's writes when its proposal is rejected", async () => {
      const store = await setup(create);
      const bad = proposal(
        {
          namespace: DIMENSION_DATA_NAMESPACE,
          key: "reputation",
          value: { ...initial, value: 99 },
        },
        "plugin.data",
      );
      const outcome = await finalize(store, bad);
      expect(outcome).toMatchObject({
        status: "committed",
        isolatedRuntimes: [
          { runtimeId: "owner/tracker", error: expect.any(String) },
        ],
      });
      expect(outcome.failedProposals.map((fp) => fp.proposal.id)).toEqual([
        bad.id,
      ]);
      expect(await record(store)).toMatchObject({ value: 0, version: 1 });
      // The narrative committed, so its obligation stays open for recovery.
      expect(await receipt(store)).toMatchObject({
        status: "pending-settlement",
      });
    });
    it("never resets evolved values on repeated initialization", async () => {
      const store = await setup(create);
      await finalize(store, tracked(5));
      const result = await createCommitPipeline(store).commitAll([
        proposal(
          { definitions: { reputation: definition } },
          "dimension.initialize",
        ),
      ]);
      expect(result.every((entry) => entry.committed)).toBe(true);
      expect(await record(store)).toMatchObject({ value: 5, version: 2 });
    });
    describe("initialization from an optional runtime", () => {
      // A story committed beside an optional initializer: the initializer's
      // write must obey the commit policy and its own savepoint.
      async function initialize(
        store: DataStore,
        options: {
          policy?: "veto" | "rewrite";
          extra?: readonly Proposal[];
        } = {},
      ) {
        await store.deletePluginData(
          "s",
          "owner",
          DIMENSION_DATA_NAMESPACE,
          "reputation",
        );
        const hookPipeline = createHookPipeline();
        hookPipeline.register({
          id: "dimension-policy",
          event: "PreStateCommit",
          handler: async (_ctx, payload) => {
            const { proposal: seen } = payload as { proposal: Proposal };
            if (seen.type !== "dimension.initialize" || !options.policy)
              return { action: "continue" };
            if (options.policy === "veto")
              return { action: "abort", reason: "Policy forbids it" };
            return {
              action: "continue",
              replace: {
                proposal: {
                  ...seen,
                  payload: {
                    definitions: {
                      reputation: { ...definition, initialValue: 7 },
                    },
                  },
                },
              },
            };
          },
        });
        const result = (
          runtimeId: string,
          pluginId: string,
          output: Record<string, unknown>,
        ) => ({
          runtimeId,
          pluginId,
          runId: runtimeId === "story" ? "narrative-result" : runtimeId,
          turnId: "t",
          status: "success",
          output,
        });
        return finalizeExecution({
          store,
          hookPipeline,
          sessionId: "s",
          turnIds: [],
          executionContext: {
            executionId: "execution",
            origin: "player",
            countPolicy: "complete-player-turn",
            logicalTurnId: "logical",
          },
          runtimes: [
            ...runtimes.slice(0, 2),
            {
              name: "owner/initializer",
              pluginId: "owner",
              outputKind: "system",
            },
          ] as RuntimeManifest[],
          results: [
            result("owner/context", "owner", {}),
            result("story", "story", {
              narrativeOutput: "The commission was completed.",
            }),
            {
              ...result("owner/initializer", "owner", {}),
              pendingProposals: [
                proposal(
                  { definitions: { reputation: definition } },
                  "dimension.initialize",
                ),
                ...(options.extra ?? []),
              ],
            },
          ],
        });
      }
      const dropped = {
        status: "committed",
        isolatedRuntimes: [
          { runtimeId: "owner/initializer", error: expect.any(String) },
        ],
      };

      it("writes the initial value and freezes it in the receipt", async () => {
        const store = await setup(create);
        const outcome = await initialize(store);
        expect(outcome.status).toBe("committed");
        expect(outcome.isolatedRuntimes).toBeUndefined();
        expect(await record(store)).toMatchObject({ value: 0, version: 1 });
        expect(await receipt(store)).toMatchObject({
          status: "pending-settlement",
          definitions: { reputation: definition },
          readVersions: { reputation: 1 },
        });
      });
      it("writes nothing when the policy vetoes initialization", async () => {
        const store = await setup(create);
        expect(await initialize(store, { policy: "veto" })).toMatchObject(
          dropped,
        );
        expect(await record(store)).toBeUndefined();
        // No committed dimension has a rule, so the story owes no settlement.
        expect(await receipt(store)).toBeUndefined();
        expect((await store.listMessages("s")).length).toBe(1);
      });
      it("writes the rewritten definition, never the one first proposed", async () => {
        const store = await setup(create);
        const outcome = await initialize(store, { policy: "rewrite" });
        expect(outcome.status).toBe("committed");
        expect(outcome.isolatedRuntimes).toBeUndefined();
        expect(await record(store)).toMatchObject({ value: 7, version: 1 });
        expect(await receipt(store)).toMatchObject({
          status: "pending-settlement",
          definitions: { reputation: { initialValue: 7 } },
          readVersions: { reputation: 1 },
        });
      });
      it("rolls initialization back with a later rejected write of the same runtime", async () => {
        const store = await setup(create);
        const rejected = proposal(
          {
            namespace: DIMENSION_DATA_NAMESPACE,
            key: "reputation",
            value: { ...initial, value: 99 },
          },
          "plugin.data",
        );
        expect(await initialize(store, { extra: [rejected] })).toMatchObject(
          dropped,
        );
        expect(await record(store)).toBeUndefined();
        expect(await receipt(store)).toBeUndefined();
      });
    });
    // P0-2 regression: a retry replays the original narrative result, whose
    // runId is the frozen source.resultId. The tracker resolves the receipt
    // by `narrative.source.resultId` — the SAME key the obligation was
    // registered under — so a retried settlement must find the pending
    // receipt, not be reported as an unknown source, and must not double-apply.
    it("retried settlement finds the pending receipt keyed by the narrative source id", async () => {
      const store = await setup(create);
      // First turn: narrative commits, tracker fails → pending obligation under
      // the narrative's source id ("narrative-result", its runId).
      expect(
        (await finalize(store, undefined, { trackerStatus: "failed" })).status,
      ).toBe("committed");
      expect(await receipt(store)).toMatchObject({
        status: "pending-settlement",
      });
      // Retry: the tracker submits updates referencing the same narrative
      // source.resultId (replayed frozen turn) — must settle, not error.
      const result = await createCommitPipeline(store).commitAll([
        proposal({
          source: { resultId: "narrative-result", turnNumber: 1 },
          readVersions: { reputation: 1 },
          updates: [{ id: "reputation", expectedVersion: 1, value: 7 }],
        }),
      ]);
      expect(result.every((entry) => entry.committed)).toBe(true);
      expect(await record(store)).toMatchObject({ value: 7, version: 2 });
      expect(await receipt(store)).toMatchObject({
        status: "settled",
        definitions: {},
        readVersions: {},
      });
      // A second retry against the now-settled source is a deduplicated no-op,
      // not a double-application.
      const again = await createCommitPipeline(store).commitAll([
        proposal({
          source: { resultId: "narrative-result", turnNumber: 1 },
          readVersions: { reputation: 1 },
          updates: [{ id: "reputation", expectedVersion: 1, value: 7 }],
        }),
      ]);
      expect(again.every((entry) => entry.committed)).toBe(true);
      expect(await record(store)).toMatchObject({ value: 7, version: 2 });
    });
  });
}
it("keeps frozen public reads separate from later writes, and publishes committed values afterward", async () => {
  const store = await setup();
  const baseline = await createWorldModelView(store, "s");
  await finalize(store, tracked(5));
  const frozen = await createWorldModelView(store, "s", [], [], undefined, {
    dimensionProviderPluginId: "owner",
    dimensions: baseline.dimensions,
  });
  expect(frozen.dimensions.reputation?.value).toBe(0);
  expect(
    (await createWorldModelView(store, "s")).dimensions.reputation?.value,
  ).toBe(5);
});

describe("story gate on the dimension provider", () => {
  const manifests = (providerFails: boolean): RuntimeManifest[] => [
    {
      name: "owner/context",
      pluginId: "owner",
      description: "provider",
      stage: "pre-turn",
      runtimeType: "function",
      handler: "./context.js",
      trigger: { type: "auto" },
      outputKind: "system",
      outputContract: DIMENSION_CONTRACT,
      ...(providerFails ? { maxRetries: 0 } : {}),
    },
    {
      name: "story/manual",
      pluginId: "story",
      description: "story",
      runtimeType: "function",
      handler: "./story.js",
      trigger: { type: "manual" },
      outputKind: "story",
    },
    {
      name: "story/auto",
      pluginId: "story",
      description: "story",
      stage: "narrative",
      runtimeType: "function",
      handler: "./story.js",
      trigger: { type: "auto" },
      outputKind: "story",
    },
  ];
  const run = async (
    providerFails: boolean,
    manualTrigger?: { runtimeId: string },
  ) => {
    const store = await setup();
    const seen: unknown[] = [];
    const result = await executeTurn(
      {
        sessionId: "s",
        turnId: "t",
        playerMessage: "go",
        ...(manualTrigger ? { manualTrigger } : {}),
      },
      manifests(providerFails),
      {
        store,
        // The host's world-context provider publishes committed dimensions.
        extensionExecution: {
          run: async () => ({
            dimensionProviderPluginId: "owner",
            dimensions: (await createWorldModelView(store, "s")).dimensions,
          }),
        } as never,
        llm: {
          generate: async () => {
            throw new Error("Function runtimes do not use the LLM");
          },
        },
        loadRuntime: async (manifest) => ({
          manifest,
          promptTemplate: "",
          handler: async (ctx) => {
            if (manifest.outputContract === DIMENSION_CONTRACT) {
              if (providerFails) throw new Error("provider down");
              return { outcome: "success", value: ctx.world!.dimensions };
            }
            seen.push(ctx.world?.dimensions.reputation?.value);
            return { outcome: "success", value: { narrativeOutput: "ok" } };
          },
        }),
      },
    );
    return { result, seen };
  };

  it("narrates a targeted manual story run from the frozen committed snapshot", async () => {
    const { result, seen } = await run(false, { runtimeId: "story/manual" });
    expect(
      result.runtimeResults.map((entry) => [entry.runtimeId, entry.status]),
    ).toEqual([["story/manual", "success"]]);
    expect(seen).toEqual([0]);
  });

  it("still blocks narration when the provider ran and failed", async () => {
    const { result, seen } = await run(true);
    expect(
      result.runtimeResults.find((entry) => entry.runtimeId === "story/auto"),
    ).toMatchObject({ status: "skipped" });
    expect(seen).toEqual([]);
  });
});

describe("settlement receipt retention", () => {
  it("keeps the newest resolved receipts and every pending one", async () => {
    const store = await setup();
    const receipt = (status: string, n: number) => ({
      source: { resultId: `old-${n}`, turnNumber: n },
      status,
      readVersions: { reputation: 1 },
      definitions: {},
      sourceTurnId: `t${n}`,
      version: 1,
    });
    // Oldest first: one unresolved receipt, then 25 resolved ones.
    for (let n = 0; n < 26; n++)
      await store.compareAndSetPluginDataBatch("s", "owner", [
        {
          namespace: DIMENSION_SETTLEMENT_NAMESPACE,
          key: `old-${n}`,
          expectedVersion: null,
          value: receipt(n === 0 ? "pending-settlement" : "settled", n),
          timestamp: `2026-10-02T00:00:${String(n).padStart(2, "0")}.000Z`,
        },
      ]);

    await store.withTransaction((tx) =>
      registerDimensionSettlements({
        sink: tx,
        sessionId: "s",
        scope: {
          provider: "owner",
          publisher: "owner/context",
          locale: "en-US",
          turnNumber: 27,
        },
        runtimes,
        results: [
          {
            runtimeId: "story",
            turnId: "t",
            runId: "new",
            status: "success",
            output: null,
          },
        ],
      }),
    );

    const keys = (
      await store.listPluginData("s", "owner", DIMENSION_SETTLEMENT_NAMESPACE)
    ).map((row) => row.key);
    expect(keys).toContain("old-0");
    expect(keys).toContain("new");
    expect(keys).not.toContain("old-1");
    expect(keys).not.toContain("old-5");
    expect(keys).toContain("old-6");
    expect(keys).toHaveLength(22);
  });
});
