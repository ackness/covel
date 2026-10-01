import { afterEach, describe, expect, it } from "vitest";
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
import { finalizeExecution } from "../src/commit/finalize-execution.js";
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
        definitions: { reputation: definition },
        readVersions: { reputation: 1 },
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
        definitions: { reputation: definition },
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
    it("retains the global rollback boundary for ordinary invalid proposals", async () => {
      const store = await setup(create);
      const bad = proposal(
        {
          namespace: DIMENSION_DATA_NAMESPACE,
          key: "reputation",
          value: { ...initial, value: 99 },
        },
        "plugin.data",
      );
      expect((await finalize(store, bad)).status).toBe("failed");
      expect(await record(store)).toMatchObject({ value: 0, version: 1 });
      expect(await receipt(store)).toBeUndefined();
      expect(await store.listMessages("s")).toEqual([]);
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
      expect(await receipt(store)).toMatchObject({ status: "settled" });
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
