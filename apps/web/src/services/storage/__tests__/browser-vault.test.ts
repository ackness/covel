import "fake-indexeddb/auto";

import { afterEach, beforeEach, describe, expect, it } from "vitest";
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
  const now = `2026-08-25T00:00:0${revision}.000Z`;
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

  it("rejects API keys and secrets before writing", async () => {
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
