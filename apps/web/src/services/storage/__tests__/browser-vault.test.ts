import "fake-indexeddb/auto";
import Dexie from "dexie";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BROWSER_CHECKPOINT_SCHEMA_VERSION } from "@covel/store/browser-sync";
import type {
  BrowserCheckpoint,
  SessionCommit,
} from "@covel/store/browser-sync";
import {
  BrowserVault,
  BrowserVaultConflictError,
  BrowserVaultSecretError,
} from "../browser-vault.js";

let vault: BrowserVault;
let databaseNumber = 0;

function checkpoint(
  sessionId: string,
  revision: number,
  actionId: string,
  patch: Partial<BrowserCheckpoint> = {},
): BrowserCheckpoint {
  const now = new Date(Date.UTC(2026, 7, 25, 0, 0, revision)).toISOString();
  return {
    schemaVersion: BROWSER_CHECKPOINT_SCHEMA_VERSION,
    sessionId,
    profile: "browser-private",
    session: {
      id: sessionId,
      status: "active",
      phase: "playing",
      completedPlayerTurns: revision,
      setupRuntimes: {},
      locale: "zh-CN",
      activePlugins: [],
      createdAt: now,
      updatedAt: now,
    },
    world: null,
    messages: [],
    turnMessages: [],
    turnResults: [],
    runtimeResults: [],
    toolCalls: [],
    runtimeOutputs: [],
    interactions: [],
    events: [],
    traceEvents: [],
    characters: [],
    pluginData: [],
    workingMemory: [],
    lorebookEntries: [],
    sessionSummaries: [],
    playerInputs: [],
    suspensions: [],
    snapshots: [],
    worldDataLedger: [],
    logicalTurnLedger: [],
    setupAttempts: [],
    jobStatus: [],
    runtimeExports: [],
    revision,
    actionId,
    committedAt: now,
    ...patch,
  };
}

function commit(next: BrowserCheckpoint): SessionCommit {
  return {
    baseRevision: next.revision - 1,
    revision: next.revision,
    actionId: next.actionId,
    checkpoint: next,
  };
}

beforeEach(() => {
  databaseNumber += 1;
  vault = new BrowserVault({
    dbName: `covel-browser-vault-test-${databaseNumber}`,
  });
});

afterEach(async () => {
  await vault.deleteDatabase();
});

describe("BrowserVault checkpoints", () => {
  it("keeps only the latest versioned checkpoint", async () => {
    await vault.saveCheckpoint(checkpoint("session-a", 1, "bootstrap"));
    await vault.saveCheckpoint(checkpoint("session-a", 2, "turn-1"));

    expect((await vault.getLatestCheckpoint("session-a"))?.revision).toBe(2);
    expect(await vault.listCheckpoints("session-a")).toHaveLength(1);
    expect((await vault.getSession("session-a"))?.revision).toBe(2);
  });

  it("rejects a conflicting revision without overwriting", async () => {
    await vault.saveCheckpoint(checkpoint("session-a", 1, "bootstrap"));
    await expect(
      vault.saveCheckpoint(
        checkpoint("session-a", 1, "bootstrap", {
          messages: [
            {
              id: "changed",
              sessionId: "session-a",
              role: "user",
              content: "changed",
              createdAt: "2026-08-25T00:00:01.000Z",
            },
          ],
        }),
      ),
    ).rejects.toBeInstanceOf(BrowserVaultConflictError);
    expect((await vault.getLatestCheckpoint("session-a"))?.messages).toEqual(
      [],
    );
  });
});

describe("BrowserVault session commits", () => {
  it("keeps commit metadata bounded as the session grows", async () => {
    for (let revision = 1; revision <= 10; revision++) {
      await vault.applySessionCommit(
        commit(
          checkpoint("session-a", revision, `turn-${revision}`, {
            committedAt: "2026-09-15T00:00:00.000Z",
            messages: [
              {
                id: "message",
                sessionId: "session-a",
                role: "user",
                content: "x".repeat(revision * 10_000),
                createdAt: "2026-09-15T00:00:00.000Z",
              },
            ],
          }),
        ),
      );
    }
    const db = new Dexie(`covel-browser-vault-test-${databaseNumber}`);
    try {
      await db.open();
      const rows = await db.table("commits").toArray();
      expect(rows).toHaveLength(10);
      expect(JSON.stringify(rows).length).toBeLessThan(10_000);
      expect(
        (await vault.getLatestCheckpoint("session-a"))?.messages[0].content
          .length,
      ).toBe(100_000);
    } finally {
      db.close();
    }
  });

  it.each([false, true])(
    "compacts v3 bodies preserving recovery and replay (interrupted: %s)",
    async (interrupted) => {
      const dbName = `covel-browser-vault-test-${databaseNumber}`;
      const old = new Dexie(dbName);
      old.version(3).stores({
        checkpoints: "sessionId, revision, committedAt",
        commits: "id, sessionId, actionId, revision, [sessionId+actionId]",
        pendingCommits: "sessionId, actionId, stagedAt",
        worlds: "id, createdAt, updatedAt",
      });
      const previous = checkpoint("session-a", 1, "turn-1");
      const next = checkpoint("session-a", 2, "turn-2");
      // The v3 format used recursively sorted JSON instead of a content hash.
      const sorted = (value: unknown): unknown =>
        Array.isArray(value)
          ? value.map(sorted)
          : value && typeof value === "object"
            ? Object.fromEntries(
                Object.entries(value)
                  .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
                  .map(([key, child]) => [key, sorted(child)]),
              )
            : value;
      await old.table("checkpoints").put({
        sessionId: "session-a",
        revision: next.revision,
        checkpoint: next,
        committedAt: next.committedAt,
      });
      for (const value of [previous, next])
        await old.table("commits").put({
          id: `session-a\0${value.actionId}`,
          sessionId: "session-a",
          actionId: value.actionId,
          baseRevision: value.revision - 1,
          revision: value.revision,
          checkpointDigest: JSON.stringify(sorted(value)),
          committedAt: value.committedAt,
        });
      await old.table("pendingCommits").put({
        sessionId: "session-a",
        actionId: "pending",
        stagedAt: next.committedAt,
      });
      old.close();
      if (interrupted) {
        const digest = crypto.subtle.digest.bind(crypto.subtle);
        let calls = 0;
        const spy = vi
          .spyOn(crypto.subtle, "digest")
          .mockImplementation((algorithm, data) => {
            if (++calls === 2)
              return Promise.reject(new Error("Synthetic digest failure"));
            return digest(algorithm, data);
          });
        try {
          await expect(vault.getLatestCheckpoint("session-a")).rejects.toThrow(
            "Synthetic digest failure",
          );
          vault.close();
          const unchanged = new Dexie(dbName);
          try {
            await unchanged.open();
            expect(unchanged.verno).toBe(3);
            const first = await unchanged
              .table("commits")
              .get("session-a\0turn-1");
            expect(first.checkpointDigest).toBe(
              JSON.stringify(sorted(previous)),
            );
          } finally {
            unchanged.close();
          }
        } finally {
          spy.mockRestore();
        }
        vault = new BrowserVault({ dbName });
      }
      expect(await vault.getLatestCheckpoint("session-a")).toEqual(next);
      expect(await vault.getPendingCommit("session-a")).toBe("pending");
      await expect(
        vault.applySessionCommit(commit(next)),
      ).resolves.toMatchObject({ duplicate: true });
      await expect(
        vault.applySessionCommit(
          commit({ ...next, session: { ...next.session, locale: "en-US" } }),
        ),
      ).rejects.toBeInstanceOf(BrowserVaultConflictError);
      const upgraded = new Dexie(dbName);
      try {
        await upgraded.open();
        const row = await upgraded.table("commits").get("session-a\0turn-2");
        expect(row.checkpointDigest).toMatch(/^sha256:[a-f0-9]{64}$/);
      } finally {
        upgraded.close();
      }
    },
  );

  it("applies a commit atomically and makes action replay a no-op", async () => {
    const next = checkpoint("session-a", 1, "turn-1");
    const value = commit(next);

    await expect(vault.applySessionCommit(value)).resolves.toMatchObject({
      applied: true,
      duplicate: false,
    });
    await expect(vault.applySessionCommit(value)).resolves.toMatchObject({
      applied: false,
      duplicate: true,
    });
    expect((await vault.getLatestCheckpoint("session-a"))?.actionId).toBe(
      "turn-1",
    );
  });

  it("rejects changed action reuse without a partial write", async () => {
    const first = checkpoint("session-a", 1, "turn-1");
    await vault.applySessionCommit(commit(first));

    const changed = checkpoint("session-a", 1, "turn-1", {
      messages: [
        {
          id: "changed",
          sessionId: "session-a",
          role: "user",
          content: "changed",
          createdAt: "2026-08-25T00:00:01.000Z",
        },
      ],
    });
    await expect(
      vault.applySessionCommit(commit(changed)),
    ).rejects.toBeInstanceOf(BrowserVaultConflictError);
    expect((await vault.getLatestCheckpoint("session-a"))?.messages).toEqual(
      [],
    );
  });

  it("rejects credential-shaped fields before writing", async () => {
    const secret = checkpoint("session-a", 1, "turn-secret", {
      session: {
        ...checkpoint("session-a", 1, "turn-secret").session,
        metadata: { apiKey: "sk-do-not-store" },
      },
    });
    await expect(
      vault.applySessionCommit(commit(secret)),
    ).rejects.toBeInstanceOf(BrowserVaultSecretError);
    expect(await vault.getLatestCheckpoint("session-a")).toBeNull();
  });

  it("allows narrative character secrets that are ordinary world content", async () => {
    await expect(
      vault.upsertWorld({
        id: "world-with-lore-secrets",
        name: "World",
        description: "",
        metadata: {
          characterBlueprints: [
            {
              schemaVersion: 1,
              id: "keeper",
              name: "Keeper",
              persona: { secrets: ["The lighthouse is still occupied."] },
            },
          ],
        },
        createdAt: "2026-08-25T00:00:00.000Z",
      }),
    ).resolves.toBeUndefined();
  });
});

describe("BrowserVault isolation and lifecycle", () => {
  it("isolates sessions and supports delete and clear", async () => {
    await vault.applySessionCommit(commit(checkpoint("session-a", 1, "a-1")));
    await vault.applySessionCommit(commit(checkpoint("session-b", 1, "b-1")));

    await vault.deleteSession("session-a");
    expect(await vault.getLatestCheckpoint("session-a")).toBeNull();
    expect(await vault.getLatestCheckpoint("session-b")).not.toBeNull();

    await vault.clear();
    expect(await vault.listSessions()).toEqual([]);
  });

  it("stores browser worlds independently and clears them explicitly", async () => {
    await vault.upsertWorld({
      id: "world-a",
      name: "World A",
      description: "",
      createdAt: "2026-08-25T00:00:00.000Z",
    });

    await expect(vault.getWorld("world-a")).resolves.toMatchObject({
      id: "world-a",
    });
    await vault.clear();
    await expect(vault.listWorlds()).resolves.toEqual([]);
  });
});
