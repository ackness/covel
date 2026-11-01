import { afterEach, describe, expect, it, vi } from "vitest";
import type { DataStore, MessageRecord } from "@covel/store";
import { createMemoryStore } from "@covel/store/memory";
import { createSqliteStore } from "@covel/store/sqlite";
import type {
  OperationRecord,
  Proposal,
  RuntimeManifest,
  RuntimeResult,
} from "@covel/shared";
import { makeSession } from "../../store/src/contract/test-fixtures.js";
import {
  finalizeExecution,
  type FinalizeExecutionArgs,
} from "../src/commit/finalize-execution.js";
import { createDisplayMessageBuffer } from "../src/commit/display-message-buffer.js";
import type { TurnEmitter } from "../src/trace/turn-emitter.js";
import { buildSessionSnapshot } from "../src/snapshot/snapshot-builder.js";

const at = "2026-10-30T00:00:00.000Z";
const open: DataStore[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  await Promise.all(open.splice(0).map((store) => store.close()));
});
function manifest(
  name: string,
  kind: "story" | "system" = "story",
  concealed = false,
): RuntimeManifest {
  return {
    name,
    pluginId: "teller",
    description: name,
    stage: "narrative",
    outputKind: kind,
    concealed,
  };
}
function result(
  runtimeId: string,
  runId = runtimeId,
  story = true,
): RuntimeResult {
  return {
    pluginId: "teller",
    runtimeId,
    runId,
    turnId: "turn",
    status: "success",
    output: story ? { narrativeOutput: `${runId} text.` } : {},
    toolCalls: [],
    durationMs: 0,
    timestamp: at,
  };
}
function withOperation(
  member: RuntimeResult,
  id = "op",
  privateChild = false,
  twoWrites = false,
): RuntimeResult {
  const record: OperationRecord = {
    id,
    contract: "change@1",
    providerPluginId: "provider",
    service: "change",
    invokedBy: {
      pluginId: privateChild ? "cast" : member.pluginId,
      runtimeId: privateChild ? "cast/private-actor" : member.runtimeId,
    },
    seq: 1,
    status: "staged",
    summary: "PRIVATE-SUMMARY",
    request: { intent: "PRIVATE-INTENT" },
    result: { notes: "PRIVATE-NOTES" },
  };
  const write = (key: string): Proposal => ({
    id: `${id}-${key}`,
    type: "plugin.data",
    sessionId: "session",
    turnId: "turn",
    source: { pluginId: "provider", runtimeId: "service:change" },
    payload: { namespace: "values", key, value: "PRIVATE-PAYLOAD" },
    timestamp: at,
  });
  return {
    ...member,
    operations: [record],
    operationWrites: {
      [id]: [write("first"), ...(twoWrites ? [write("second")] : [])],
    },
  };
}
async function seed(create: () => DataStore) {
  vi.useFakeTimers({ toFake: ["Date"], now: new Date(at) });
  const store = create();
  open.push(store);
  await store.createSession(
    makeSession({
      id: "session",
      activePlugins: ["teller", "provider"],
      phase: "playing",
    }),
  );
  return store;
}
function args(
  store: DataStore,
  results: readonly RuntimeResult[],
  runtimes = [manifest("story")],
): FinalizeExecutionArgs {
  return {
    store,
    sessionId: "session",
    executionContext: {
      executionId: crypto.randomUUID(),
      origin: "player",
      countPolicy: "none",
    },
    results,
    runtimes,
    turnIds: [],
    proposalGuard: (proposal) =>
      proposal.source.pluginId === "provider" ? "PRIVATE-ERROR" : undefined,
  };
}
const meta = (row: MessageRecord) => row.metadata as Record<string, unknown>;
const markers = (rows: MessageRecord[]) =>
  rows
    .filter((row) => meta(row)?.operationFailures)
    .map((row) => ({
      messageId: row.id,
      ...(meta(row).operationFailures as { count: number }),
    }));

for (const [backend, create] of [
  ["memory", createMemoryStore],
  ["sqlite", () => createSqliteStore(":memory:")],
] as const) {
  describe(`persistent story notices on ${backend}`, () => {
    it("counts one operation once despite two refused proposals and exposes only aggregate metadata", async () => {
      const store = await seed(create);
      const member = withOperation(result("story"), "op", true, true);
      await store.saveTurnResult({
        id: "row",
        sessionId: "session",
        turnId: "turn",
        runtimeResults: [member],
        origin: "player",
        commitStatus: "pending",
        durationMs: 0,
        createdAt: at,
      });
      const out = await finalizeExecution({
        ...args(store, [member]),
        turnIds: ["turn"],
        journalMessages: [
          {
            id: "journal",
            sessionId: "session",
            turnId: "turn",
            sourceType: "runtime",
            sourceRuntimeId: "story",
            role: "assistant",
            content: "story text.",
            order: 0,
            createdAt: at,
          },
        ],
      });
      const rows = await store.listMessages("session");
      expect(out.status).toBe("committed");
      expect(out.failedProposals).toHaveLength(2);
      expect(out.operations).toMatchObject([
        { status: "failed", reason: "rejected" },
      ]);
      expect(rows.map((row) => row.content)).toEqual(["story text."]);
      expect(markers(rows)).toEqual([{ messageId: rows[0]!.id, count: 1 }]);
      expect(out.operationFailureMessages).toEqual(markers(rows));
      expect(await store.listPluginData("session", "provider")).toEqual([]);
      expect((await store.listTurnResults("session"))[0]).toMatchObject({
        commitStatus: "committed",
        runtimeResults: [{ operations: [{ status: "failed" }] }],
      });
      expect((await store.listTurnMessages("session"))[0]?.content).toBe(
        "story text.",
      );
      const view = await buildSessionSnapshot(store, "session");
      expect(view?.messages[0]?.operationFailures).toEqual({ count: 1 });
      const publicArtifacts = JSON.stringify([
        rows.map((row) => row.metadata),
        out.operationFailureMessages,
        view?.messages,
      ]);
      for (const sentinel of [
        "PRIVATE-SUMMARY",
        "PRIVATE-INTENT",
        "PRIVATE-NOTES",
        "PRIVATE-PAYLOAD",
        "PRIVATE-ERROR",
        "cast/private-actor",
        "change@1",
      ])
        expect(publicArtifacts).not.toContain(sentinel);
    });

    it("keeps nested and top-level runs of one runtime in separate units and selects only the root's last story", async () => {
      const store = await seed(create);
      const child = withOperation(result("same", "nested"), "child-op");
      const root = result("story", "parent");
      const later = result("same", "top-level");
      const out = await finalizeExecution({
        ...args(
          store,
          [child, root, later],
          [manifest("same"), manifest("story")],
        ),
        commitUnits: [2, 1],
      });
      const rows = await store.listMessages("session");
      expect(rows.map((row) => row.content)).toEqual([
        "nested text.",
        "parent text.",
        "top-level text.",
      ]);
      expect(markers(rows)).toEqual([{ messageId: rows[1]!.id, count: 1 }]);
      expect(out.operationFailureMessages).toEqual(markers(rows));
    });

    it("never attaches a later unit's failed operation to an earlier story", async () => {
      const store = await seed(create);
      const first = result("story", "first");
      const later = withOperation(result("story", "later"), "later-op");
      const extra: Proposal = {
        id: "earlier-segment",
        sessionId: "session",
        turnId: "turn",
        source: { pluginId: "teller", runtimeId: "story" },
        type: "narrative.append",
        payload: { content: "Extra story paragraph.", kind: "story" },
        timestamp: at,
      };
      const out = await finalizeExecution(
        args(store, [first, { ...later, pendingProposals: [extra] }]),
      );
      const rows = await store.listMessages("session");
      expect(rows).toHaveLength(3);
      expect(markers(rows)).toEqual([{ messageId: rows[2]!.id, count: 1 }]);
      expect(out.operationFailureMessages).toEqual(markers(rows));
      expect(meta(rows[0]!)).not.toHaveProperty("operationFailures");
    });

    it("falls back to the last public member story when the root is system", async () => {
      const store = await seed(create);
      const child = result("story", "nested");
      const root = withOperation(result("root", "root", false));
      const out = await finalizeExecution({
        ...args(
          store,
          [child, root],
          [manifest("story"), manifest("root", "system")],
        ),
        commitUnits: [2],
      });
      expect(out.operationFailureMessages).toEqual(
        markers(await store.listMessages("session")),
      );
      expect(out.operationFailureMessages).toHaveLength(1);
    });

    it.each(["concealed", "auxiliary", "discarded", "success"] as const)(
      "creates no false annotation for %s",
      async (scenario) => {
        const store = await seed(create);
        const publicStory = result("story", "public");
        const other = withOperation(
          result("other", "other", scenario === "concealed"),
        );
        const out = await finalizeExecution({
          ...args(
            store,
            [
              publicStory,
              scenario === "discarded"
                ? { ...other, status: "failed", output: null }
                : other,
            ],
            [
              manifest("story"),
              manifest(
                "other",
                scenario === "concealed" ? "story" : "system",
                scenario === "concealed",
              ),
            ],
          ),
          ...(scenario === "success" ? { proposalGuard: undefined } : {}),
        });
        expect(out.status).toBe("committed");
        if (scenario === "auxiliary") {
          expect(
            out.operations.filter((operation) => operation.status === "failed"),
          ).toHaveLength(1);
          expect(out.operationFailureMessages).toEqual([]);
        }
        expect(markers(await store.listMessages("session"))).toEqual([]);
        expect(out.operationFailureMessages).toEqual([]);
      },
    );

    it("returns no receipt and rolls back story, marker, journal and domain writes after a late store failure", async () => {
      const store = await seed(create);
      const emitted = vi.fn();
      const emitter = {
        emit: emitted,
        sessionId: "session",
        turnId: "turn",
        traceId: "trace",
      } as unknown as TurnEmitter;
      const member = withOperation({
        ...result("story"),
        effects: {
          pluginData: [{ namespace: "notes", key: "told", value: true }],
          ui: [
            {
              parts: [
                {
                  id: "status",
                  type: "notification",
                  status: "success",
                  content: "A saved card.",
                },
              ],
            },
          ],
        },
      });
      await store.saveTurnResult({
        id: "pending-row",
        sessionId: "session",
        turnId: "turn",
        runtimeResults: [member],
        origin: "player",
        commitStatus: "pending",
        durationMs: 0,
        createdAt: at,
      });
      const out = await finalizeExecution({
        ...args(store, [member]),
        emitter,
        turnIds: ["turn"],
        journalMessages: [
          {
            id: "journal",
            sessionId: "session",
            turnId: "turn",
            sourceType: "runtime",
            sourceRuntimeId: "story",
            role: "assistant",
            content: "story text.",
            order: 0,
            createdAt: at,
          },
        ],
        extraInTx: async (tx) => {
          expect(markers(await tx.listMessages("session"))).toHaveLength(1);
          expect((await tx.listTurnMessages("session"))[0]?.content).toBe(
            "story text.",
          );
          throw new Error("Synthetic late write failure");
        },
      });
      expect(out.status).toBe("failed");
      expect(out.operationFailureMessages).toBeUndefined();
      expect(await store.listMessages("session")).toEqual([]);
      expect(await store.listPluginData("session", "teller")).toEqual([]);
      expect(await store.listTurnMessages("session")).toEqual([]);
      expect((await store.listTurnResults("session"))[0]).toMatchObject({
        commitStatus: "failed",
        runtimeResults: [
          { operations: [{ status: "discarded", reason: "execution-failed" }] },
        ],
      });
      expect(emitted).not.toHaveBeenCalledWith(
        "ui.rendered",
        expect.anything(),
      );
      expect(emitted).not.toHaveBeenCalledWith(
        "narrative.completed",
        expect.anything(),
      );
      expect((await finalizeExecution(args(store, [member]))).status).toBe(
        "committed",
      );
    });

    it("rolls back every buffered row and domain write when inserting the annotated message fails", async () => {
      const store = await seed(create);
      const transaction = store.withTransaction.bind(store);
      const failure = vi
        .spyOn(store, "withTransaction")
        .mockImplementation((body) =>
          transaction((tx) =>
            body(
              new Proxy(tx, {
                get(target, property) {
                  if (property === "addMessage")
                    return async (record: MessageRecord) => {
                      if (
                        (record.metadata as Record<string, unknown>)
                          ?.operationFailures
                      )
                        throw new Error("Synthetic marker insert failure");
                      await target.addMessage(record);
                    };
                  const value: unknown = Reflect.get(target, property);
                  return typeof value === "function"
                    ? value.bind(target)
                    : value;
                },
              }),
            ),
          ),
        );
      const member = withOperation({
        ...result("story"),
        effects: {
          pluginData: [{ namespace: "notes", key: "told", value: true }],
          notifications: [{ message: "A UI row before flush." }],
        },
      });
      const out = await finalizeExecution(args(store, [member]));
      expect(out.status).toBe("failed");
      expect(out.operationFailureMessages).toBeUndefined();
      expect(await store.listMessages("session")).toEqual([]);
      expect(await store.listPluginData("session", "teller")).toEqual([]);
      failure.mockRestore();
      expect((await finalizeExecution(args(store, [member]))).status).toBe(
        "committed",
      );
    });

    it("keeps the stored notice and receipt when post-commit publication fails", async () => {
      const store = await seed(create);
      const emitter = {
        emit: vi
          .fn()
          .mockRejectedValue(new Error("Synthetic lost publication")),
        sessionId: "session",
        turnId: "turn",
        traceId: "trace",
      } as unknown as TurnEmitter;
      const member = withOperation({
        ...result("story"),
        effects: {
          ui: [
            {
              parts: [
                {
                  id: "status",
                  type: "notification",
                  status: "success",
                  content: "A saved card.",
                },
              ],
            },
          ],
        },
      });
      const out = await finalizeExecution({
        ...args(store, [member, result("story", "later")]),
        emitter,
      });
      expect(out.status).toBe("committed");
      expect(out.fanOutFailed).toBe(true);
      const rows = await store.listMessages("session");
      expect(rows.map((row) => meta(row).kind)).toEqual([
        "story",
        "plugin",
        "story",
      ]);
      expect(rows.map((row) => row.createdAt)).toEqual([at, at, at]);
      expect(rows.map((row) => row.content)).toEqual([
        "story text.",
        "",
        "later text.",
      ]);
      expect(out.operationFailureMessages).toEqual(
        markers(await store.listMessages("session")),
      );
      expect(
        (await buildSessionSnapshot(store, "session"))?.messages[0]
          ?.operationFailures,
      ).toEqual({ count: 1 });
    });

    it.each(["resume", "manual"] as const)(
      "persists through the common %s commit boundary and leaves historic notices unchanged",
      async (origin) => {
        const store = await seed(create);
        const out = await finalizeExecution({
          ...args(store, [withOperation(result("story"))]),
          executionContext: {
            executionId: "execution",
            origin,
            countPolicy: "none",
          },
        });
        expect(out.status).toBe("committed");
        const original = (await store.listMessages("session"))[0]!;
        await finalizeExecution({
          ...args(store, [
            { ...result("story", "retry"), turnId: "retry-turn" },
          ]),
          executionContext: {
            executionId: "retry",
            origin: "manual",
            sourceTurnId: "turn",
            countPolicy: "none",
          },
        });
        await store.updateSession("session", { activePlugins: [] });
        expect(await store.getMessage("session", original.id)).toEqual(
          original,
        );
        expect(
          (await buildSessionSnapshot(store, "session"))?.messages.map(
            (row) => row.operationFailures,
          ),
        ).toEqual([{ count: 1 }, undefined]);
      },
    );

    it("preserves same-timestamp message order, transactional reads and savepoint rollback in the buffer", async () => {
      const store = await seed(create);
      const row = (id: string): MessageRecord => ({
        id,
        sessionId: "session",
        role: "assistant",
        content: id,
        metadata: { kind: "story" },
        createdAt: at,
      });
      await store.withTransaction(async (tx) => {
        const buffer = createDisplayMessageBuffer(tx);
        await buffer.store.addMessage(row("z-story"));
        await expect(
          buffer.store.savepoint!(async (sp) => {
            await sp.addMessage(row("discarded"));
            expect((await sp.listMessages("session")).map((m) => m.id)).toEqual(
              ["z-story", "discarded"],
            );
            throw new Error("rollback savepoint");
          }),
        ).rejects.toThrow("rollback savepoint");
        await buffer.store.addMessage(row("a-ui"));
        expect(
          await buffer.store.getMessage("session", "discarded"),
        ).toBeNull();
        expect(await buffer.store.getMessage("session", "z-story")).toEqual(
          row("z-story"),
        );
        expect(
          await buffer.store.listExistingMessageIds("session", [
            "a-ui",
            "discarded",
          ]),
        ).toEqual(["a-ui"]);
        expect(
          (
            await buffer.store.listMessagesPage("session", {
              limit: 5,
              before: { id: "a-ui", createdAt: at },
            })
          ).map((m) => m.id),
        ).toEqual(["z-story"]);
        expect(await tx.listMessages("session")).toEqual([]);
        await buffer.flush({ messageId: "z-story", count: 1 });
        expect((await tx.listMessages("session")).map((m) => m.id)).toEqual([
          "z-story",
          "a-ui",
        ]);
      });
    });
  });
}
