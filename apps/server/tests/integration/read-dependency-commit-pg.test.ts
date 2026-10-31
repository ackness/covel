/**
 * Read dependencies at commit on real PostgreSQL.
 *
 * A runtime that read an earlier runtime's uncommitted plugin data is dropped
 * with it when the commit refuses that runtime's writes. On PostgreSQL the
 * refusal comes from inside the transaction: the producer's operation list
 * goes out of bounds against a row a concurrent commit changed. The
 * producer's unit rolls back whole, its reader is dropped, and the story
 * commits.
 *
 * Skipped when `DATABASE_URL` is not set or PG is unreachable, unless
 * `COVEL_REQUIRE_PG_TESTS=1` (`pnpm test:pg`).
 */

import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import type {
  HandlerResult,
  JsonValue,
  RuntimeManifest,
  RuntimeResult,
} from "@covel/shared";
import type { FunctionHandler } from "@covel/shared/plugin-runtime";
import type { DataStore } from "@covel/store";
import { createPgStore } from "@covel/store/postgres";
import {
  classifyExecutionFaults,
  commitExecution,
  executeTurn,
} from "@covel/runtime";
import { createEventBus } from "@covel/events";
import { withPendingProposals } from "@covel/tools";
import {
  createIsolatedPgDatabase,
  type IsolatedPgDatabase,
} from "./pg-test-db.js";

const BASE_URL =
  process.env.DATABASE_URL ??
  "postgresql://covel:covel_dev@localhost:5432/covel";
const REQUIRE_PG = process.env.COVEL_REQUIRE_PG_TESTS === "1";
let isolatedDatabase: IsolatedPgDatabase | undefined;

async function createIsolatedPgUrl(): Promise<string | null> {
  try {
    isolatedDatabase = await createIsolatedPgDatabase(
      BASE_URL,
      "covel_test_read_dependency_pg",
    );
    return isolatedDatabase.url;
  } catch (error) {
    if (REQUIRE_PG) {
      throw new Error("PostgreSQL is required for read-dependency tests", {
        cause: error,
      });
    }
    return null;
  }
}

const isolatedUrl = await createIsolatedPgUrl();

const SESSION = "pg-read-dependency";
const PLUGIN = "pg-read-dependency";
const AT = "2026-10-29T00:00:00.000Z";

function fn(id: string, extra: Partial<RuntimeManifest> = {}): RuntimeManifest {
  return {
    name: `${PLUGIN}/${id}`,
    pluginId: PLUGIN,
    description: id,
    runtimeType: "function",
    stage: "post-turn",
    outputKind: "system",
    trigger: { type: "auto" },
    ...extra,
  } as RuntimeManifest;
}

const ok = (value: Record<string, JsonValue> = {}): HandlerResult => ({
  outcome: "success",
  value,
});

async function storeGold(store: DataStore, value: number): Promise<void> {
  await store.setPluginData({
    id: `${SESSION}:${PLUGIN}:notes:gold`,
    sessionId: SESSION,
    pluginId: PLUGIN,
    namespace: "notes",
    key: "gold",
    value,
    createdAt: AT,
    updatedAt: AT,
  });
}

describe.skipIf(!isolatedUrl)("read dependencies on real PG", () => {
  let store: DataStore;

  beforeAll(async () => {
    store = await createPgStore(isolatedUrl!, { freshSchema: true });
  });

  afterAll(async () => {
    await store?.close();
    await isolatedDatabase?.cleanup();
  }, 90_000);

  afterEach(async () => {
    vi.restoreAllMocks();
    await store?.deleteSession(SESSION);
  });

  it.each(["plugin-data", "world", "world-suspension"] as const)(
    "rolls back a refused producer and its %s reader while keeping the story",
    async (readMode) => {
      vi.spyOn(console, "warn").mockImplementation(() => {});
      await store.createSession({
        id: SESSION,
        locale: "en-US",
        status: "active",
        phase: "playing",
        setupRuntimes: {},
        seats: [
          {
            id: "main",
            controller: "human",
            role: "player",
            characters: "auto",
          },
        ],
        activePlugins: [PLUGIN, "pg-world-reader"],
        completedPlayerTurns: 1,
        metadata: {
          approvalScopeNonce: globalThis.crypto.randomUUID(),
          sessionIncarnationNonce: globalThis.crypto.randomUUID(),
        },
        createdAt: AT,
        updatedAt: AT,
      });
      await storeGold(store, 5);

      const story = fn("story", { stage: "narrative", outputKind: "story" });
      const producer = fn("producer", { stage: "pre-turn" });
      const reader = fn(
        "reader",
        readMode === "plugin-data"
          ? {}
          : { pluginId: "pg-world-reader", name: "pg-world-reader/read" },
      );
      const eventBus = createEventBus(store);
      const suspendedEvents: unknown[] = [];
      eventBus.onEmit((event) => {
        if (event.type === "turn.suspended") suspendedEvents.push(event);
      });
      const handlers: Record<string, FunctionHandler> = {
        [story.name]: async (ctx) => {
          await ctx.pluginData!.set("notes", "told", "told");
          return ok({ narrativeOutput: "The story goes on." });
        },
        [producer.name]: async (ctx) => {
          // Readable data first, then a list that passes against 5 gold.
          await ctx.pluginData!.set("notes", "ready", "ready");
          await ctx.pluginData!.update("notes", "gold", [
            { op: "inc", by: -5, min: 0 },
          ]);
          return readMode === "plugin-data"
            ? ok()
            : withPendingProposals(ok(), [
                {
                  id: crypto.randomUUID(),
                  type: "character.upsert",
                  sessionId: SESSION,
                  turnId: ctx.turnId,
                  source: { pluginId: PLUGIN, runtimeId: producer.name },
                  timestamp: AT,
                  payload: {
                    id: "staged-character",
                    name: "Visitor",
                    type: "npc",
                    description: "staged description",
                  },
                },
              ]);
        },
        [reader.name]: async (ctx) => {
          const seen =
            readMode === "plugin-data"
              ? await ctx.pluginData!.get("notes", "ready")
              : ctx.world!.characters.find(
                  (character) => character.id === "staged-character",
                )?.description;
          expect(seen).toBe(
            readMode === "plugin-data" ? "ready" : "staged description",
          );
          await ctx.pluginData!.set("notes", "reader", String(seen));
          return readMode === "world-suspension"
            ? {
                outcome: "suspended",
                reason: "Need input",
                resumeSchema: { type: "object" },
              }
            : ok();
        },
      };
      const execution = await executeTurn(
        {
          sessionId: SESSION,
          turnId: "turn",
          logicalTurnId: "logical-turn",
          playerMessage: "Continue",
          origin: "player",
        },
        [story, producer, reader],
        {
          store,
          eventBus,
          llm: {
            generate: async () => {
              throw new Error("Functions do not use a model");
            },
          },
          loadRuntime: async (runtime) => ({
            manifest: runtime,
            promptTemplate: "",
            handler: handlers[runtime.name],
          }),
        },
      );
      const runOf = (runtimeId: string) =>
        execution.commit.results.find(
          (result) => result.runtimeId === runtimeId,
        )!.runId;
      expect(execution.commit.readDependencies).toEqual({
        [runOf(reader.name)]: [runOf(producer.name)],
      });

      if (readMode === "world-suspension")
        expect(execution.commit.suspensions).toHaveLength(1);
      // A concurrent commit spends gold, so the list goes out of bounds.
      await storeGold(store, 3);
      const outcome = await commitExecution({
        store,
        eventBus,
        execution,
        completion: { kind: "turn", turnId: "turn", durationMs: 0 },
      });

      expect(outcome.status).toBe("committed");
      expect(outcome.isolatedRuntimes).toEqual([
        {
          runtimeId: producer.name,
          runId: runOf(producer.name),
          cause: "rejected",
          error: expect.stringMatching(
            /^plugin\.data\.update: .*\(op 0, out-of-bounds\)$/,
          ),
        },
        {
          runtimeId: reader.name,
          runId: runOf(reader.name),
          cause: "read",
          error: `read data of ${producer.name} that did not commit`,
        },
      ]);
      const rows = Object.fromEntries(
        (await store.listPluginData(SESSION, PLUGIN, "notes")).map((row) => [
          row.key,
          row.value,
        ]),
      );
      expect(rows).toEqual({ gold: 3, told: "told" });
      expect(await store.listCharacters(SESSION)).toEqual([]);
      expect(await store.listSuspensions(SESSION)).toEqual([]);
      expect(suspendedEvents).toEqual([]);
      if (readMode !== "plugin-data") {
        expect(
          classifyExecutionFaults(execution.commit.results, outcome).get(
            reader.pluginId,
          ),
        ).toEqual({ kind: "neutral" });
        expect(
          await store.listPluginData(SESSION, reader.pluginId, "notes"),
        ).toEqual([]);
      }
      expect(
        (await store.listMessages(SESSION)).map((message) => message.content),
      ).toContain("The story goes on.");
      const persisted = (await store.listTurnResults(SESSION)).flatMap(
        (row) => row.runtimeResults as RuntimeResult[],
      );
      expect(
        persisted.find((result) => result.runId === runOf(reader.name)),
      ).toMatchObject({
        status: "failed",
        error: `read data of ${producer.name} that did not commit`,
      });
    },
  );
});
