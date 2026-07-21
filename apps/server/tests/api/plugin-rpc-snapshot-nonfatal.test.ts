/**
 * A failed auto-snapshot must not fail an otherwise-committed turn. The
 * proposals are already durable (commit_status is "committed"); the snapshot is
 * a best-effort checkpoint and the next turn takes another. Counting it as a
 * failure made the sync RPC return 500 and the client retry, replaying the
 * already-committed proposals. So `TurnCommitOutcome.committed` tracks proposal
 * commit alone — even a runtime that emits zero proposals stays committed when
 * only the snapshot write throws.
 */

import { describe, it, expect, vi } from "vitest";
import { createMemoryStore, type DataStore } from "@covel/store";
import { createEventBus } from "@covel/events";
import type { RuntimeManifest } from "@covel/shared";
import type { LoadedRuntime } from "@covel/plugin-loader";
import { createInProcessSessionLock } from "../../src/lib/session-lock.js";
import { createPluginRpcRuntimeTurnRunner } from "../../src/routes/api/plugin-rpc/runtime-turn.js";

const SESSION_ID = "sess-snap-nonfatal";
const PLUGIN_ID = "demo";
const RUNTIME_ID = "demo/worker";

function manifest(): RuntimeManifest {
  return {
    name: RUNTIME_ID,
    pluginId: PLUGIN_ID,
    description: "snapshot non-fatal fixture",
    runtimeType: "function",
    priority: 500,
    trigger: { type: "manual" },
  };
}

describe("auto-snapshot failure is non-fatal to a committed turn", () => {
  it("keeps the turn committed when only saveSnapshot throws", async () => {
    const base = createMemoryStore();
    // Proposals commit normally; only the snapshot write fails.
    const store: DataStore = {
      ...base,
      saveSnapshot: async () => {
        throw new Error("disk full");
      },
    };
    const now = new Date().toISOString();
    await store.createSession({
      id: SESSION_ID,
      worldId: null,
      status: "active",
      presetId: null,
      activePlugins: [PLUGIN_ID],
      turnCount: 1,
      preGameCompleted: [],
      createdAt: now,
      updatedAt: now,
    });

    const loaded: LoadedRuntime = {
      manifest: manifest(),
      promptTemplate: "",
      handler: async () => ({ ok: true }),
    };

    const runner = createPluginRpcRuntimeTurnRunner({
      store,
      eventBus: createEventBus(store),
      sessionLock: createInProcessSessionLock(),
      sessionId: SESSION_ID,
      session: { locale: "en" },
      activeRuntimes: [manifest()],
      deps: {
        loadRuntime: async (m) => (m.name === RUNTIME_ID ? loaded : undefined),
        llm: { generate: vi.fn() },
      } as unknown as Parameters<
        typeof createPluginRpcRuntimeTurnRunner
      >[0]["deps"],
    });

    const summary = await runner.runManualTurn({
      turnId: "turn-snap-1",
      runtimeId: RUNTIME_ID,
    });

    expect(summary.commit.snapshotFailed).toBe(true);
    // Snapshot failed, but the turn committed — not reported as a failure.
    expect(summary.commit.committed).toBe(true);
    expect(summary.commit.failedProposalCount).toBe(0);
  });
});
