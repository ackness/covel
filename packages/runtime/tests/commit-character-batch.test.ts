import { describe, expect, it, vi } from "vitest";
import type { CharacterUpsertPayload, Proposal } from "@covel/shared";
import { createMemoryStore } from "@covel/store/memory";
import {
  makeCharacter,
  makeSession,
} from "../../store/src/contract/test-fixtures.js";
import { createCommitPipeline } from "../src/commit/session-commit-pipeline.js";

const SESSION_ID = "sess-1";

function upsert(payload: CharacterUpsertPayload): Proposal {
  return {
    id: crypto.randomUUID(),
    type: "character.upsert",
    source: { pluginId: "fixture", runtimeId: "fixture" },
    turnId: "turn-1",
    sessionId: SESSION_ID,
    payload,
    timestamp: "2026-10-11T00:00:00.000Z",
  };
}

async function seededStore() {
  const store = createMemoryStore();
  await store.createSession(makeSession({ id: SESSION_ID }));
  await store.upsertCharacter(
    makeCharacter({
      id: "ari",
      sessionId: SESSION_ID,
      name: "Ari",
      aliases: ["Red"],
      type: "npc",
      version: 1,
    }),
  );
  await store.upsertCharacter(
    makeCharacter({
      id: "mira",
      sessionId: SESSION_ID,
      name: "Mira",
      type: "npc",
      version: 1,
    }),
  );
  return store;
}

async function aliasesOf(
  store: Awaited<ReturnType<typeof seededStore>>,
): Promise<Record<string, readonly string[]>> {
  return Object.fromEntries(
    (await store.listCharacters(SESSION_ID)).map((character) => [
      character.id,
      character.aliases ?? [],
    ]),
  );
}

/** The two ways a batch reaches the handlers: its own transaction, or the caller's. */
const paths = [
  {
    name: "in its own transaction",
    commitAll: async (
      store: Awaited<ReturnType<typeof seededStore>>,
      proposals: readonly Proposal[],
    ) => {
      const reads = vi.fn();
      const results = await createCommitPipeline({
        ...store,
        withTransaction: (fn) =>
          store.withTransaction((tx) => fn(countingReads(tx, reads))),
      }).commitAll(proposals);
      return { results, reads };
    },
  },
  {
    name: "inside the caller's transaction",
    commitAll: async (
      store: Awaited<ReturnType<typeof seededStore>>,
      proposals: readonly Proposal[],
    ) => {
      const reads = vi.fn();
      const results = await store.withTransaction((tx) =>
        createCommitPipeline(
          countingReads(tx, reads),
          undefined,
          undefined,
          undefined,
          undefined,
          { preStateCommitApplied: true },
        ).commitAll(proposals),
      );
      return { results, reads };
    },
  },
] as const;

function countingReads<T extends { listCharacters: (id: string) => unknown }>(
  view: T,
  reads: () => void,
): T {
  return {
    ...view,
    listCharacters: (sessionId: string) => {
      reads();
      return view.listCharacters(sessionId);
    },
  };
}

describe.each(paths)(
  "character writes of one commit, $name",
  ({ commitAll }) => {
    it("reads the characters once and refuses a name an earlier record took", async () => {
      const store = await seededStore();

      const { results, reads } = await commitAll(store, [
        upsert({
          id: "ari",
          name: "Ari",
          aliases: ["Fox"],
          expectedVersion: 1,
        }),
        upsert({
          id: "mira",
          name: "Mira",
          aliases: ["fox"],
          expectedVersion: 1,
        }),
        upsert({ id: "new", name: "Fox" }),
      ]);

      expect(results.map((result) => result.committed)).toEqual([
        true,
        false,
        false,
      ]);
      expect(results[1]!.error).toContain("[ari]");
      expect(results[2]!.error).toContain("[ari]");
      expect(reads).toHaveBeenCalledOnce();
      expect(await aliasesOf(store)).toEqual({ ari: ["Red", "Fox"], mira: [] });
    });

    it("lets a second character take an alias the first gave up", async () => {
      const store = await seededStore();

      const { results, reads } = await commitAll(store, [
        upsert({
          id: "ari",
          name: "Ari",
          removeAliases: ["Red"],
          expectedVersion: 1,
        }),
        upsert({
          id: "mira",
          name: "Mira",
          aliases: ["Red"],
          expectedVersion: 1,
        }),
        upsert({
          id: "ari",
          name: "Ari",
          aliases: ["Red"],
          expectedVersion: 2,
        }),
      ]);

      expect(results.map((result) => result.committed)).toEqual([
        true,
        true,
        false,
      ]);
      expect(reads).toHaveBeenCalledOnce();
      expect(await aliasesOf(store)).toEqual({ ari: [], mira: ["Red"] });
    });
  },
);

it("reads again for the next commit, so a write made between two commits counts", async () => {
  const store = await seededStore();
  const pipeline = createCommitPipeline(store);

  const [first] = await pipeline.commitAll([
    upsert({ id: "ari", name: "Ari", aliases: ["Fox"], expectedVersion: 1 }),
  ]);
  await store.upsertCharacter(
    makeCharacter({
      id: "kestrel",
      sessionId: SESSION_ID,
      name: "Kestrel",
      aliases: ["Hawk"],
      type: "npc",
    }),
  );
  const [second] = await pipeline.commitAll([
    upsert({ id: "mira", name: "Mira", aliases: ["Hawk"], expectedVersion: 1 }),
  ]);

  expect(first!.committed).toBe(true);
  expect(second!.committed).toBe(false);
  expect(second!.error).toContain("[kestrel]");
});

it("drops the held view with a rolled-back commit", async () => {
  const store = await seededStore();
  const failing = createCommitPipeline({
    ...store,
    withTransaction: (fn) =>
      store.withTransaction((tx) =>
        fn({
          ...tx,
          addTraceEvent: async () => {
            throw new Error("disk full");
          },
        }),
      ),
  });

  await expect(
    failing.commitAll([
      upsert({
        id: "ari",
        name: "Ari",
        removeAliases: ["Red"],
        expectedVersion: 1,
      }),
    ]),
  ).rejects.toThrow("disk full");
  const [retaken] = await createCommitPipeline(store).commitAll([
    upsert({ id: "mira", name: "Mira", aliases: ["Red"], expectedVersion: 1 }),
  ]);

  expect(retaken!.committed).toBe(false);
  expect(await aliasesOf(store)).toEqual({ ari: ["Red"], mira: [] });
});
