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
import { sessionApprovalScope } from "../../src/routes/api/session/session-guard.js";

const SESSION_ID = "sess-snap-nonfatal";
const PLUGIN_ID = "demo";
const RUNTIME_ID = "demo/worker";

function manifest(): RuntimeManifest {
  return {
    name: RUNTIME_ID,
    pluginId: PLUGIN_ID,
    description: "snapshot non-fatal fixture",
    runtimeType: "function",
    stage: "narrative",
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
      phase: "playing",
      setupRuntimes: {},
      metadata: {
        approvalScopeNonce: globalThis.crypto.randomUUID(),
        sessionIncarnationNonce: globalThis.crypto.randomUUID(),
      },
      id: SESSION_ID,
      worldId: null,
      status: "active",
      presetId: null,
      activePlugins: [PLUGIN_ID],
      completedPlayerTurns: 1,

      createdAt: now,
      updatedAt: now,
    });

    const loaded: LoadedRuntime = {
      manifest: manifest(),
      promptTemplate: "",
      handler: async () => ({ ok: true }),
    };
    const session = await store.getSession(SESSION_ID);
    if (!session) throw new Error("expected session");

    const runner = createPluginRpcRuntimeTurnRunner({
      store,
      eventBus: createEventBus(store),
      sessionLock: createInProcessSessionLock(),
      sessionId: SESSION_ID,
      session: { locale: "en" },
      activeRuntimes: [manifest()],
      approvalScopes: new Map([
        [PLUGIN_ID, sessionApprovalScope(session, PLUGIN_ID)],
      ]),
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

  it.each([
    ["manual", false],
    ["background", true],
  ] as const)(
    "persists a %s suspension without completing the turn",
    async (_mode, detached) => {
      const store = createMemoryStore();
      const now = new Date().toISOString();
      await store.createSession({
        phase: "playing",
        setupRuntimes: {},
        metadata: {
          approvalScopeNonce: globalThis.crypto.randomUUID(),
          sessionIncarnationNonce: globalThis.crypto.randomUUID(),
        },
        id: SESSION_ID,
        worldId: null,
        status: "active",
        presetId: null,
        activePlugins: [PLUGIN_ID],
        completedPlayerTurns: 1,

        createdAt: now,
        updatedAt: now,
      });
      const loaded: LoadedRuntime = {
        manifest: manifest(),
        promptTemplate: "",
        handler: async () =>
          ({
            outcome: "suspended",
            reason: "need input",
            resumeSchema: {},
          }) as never,
      };
      const session = await store.getSession(SESSION_ID);
      if (!session) throw new Error("expected session");
      const eventBus = createEventBus(store);
      const eventTypes: string[] = [];
      eventBus.onEmit((event) => eventTypes.push(event.type));
      const runner = createPluginRpcRuntimeTurnRunner({
        store,
        eventBus,
        sessionLock: createInProcessSessionLock(),
        sessionId: SESSION_ID,
        session: { locale: "en" },
        activeRuntimes: [manifest()],
        approvalScopes: new Map([
          [PLUGIN_ID, sessionApprovalScope(session, PLUGIN_ID)],
        ]),
        deps: {
          loadRuntime: async (m) =>
            m.name === RUNTIME_ID ? loaded : undefined,
          llm: { generate: vi.fn() },
        } as unknown as Parameters<
          typeof createPluginRpcRuntimeTurnRunner
        >[0]["deps"],
      });

      const summary = await runner.runManualTurn({
        turnId: `turn-suspended-${_mode}`,
        runtimeId: RUNTIME_ID,
        ...(detached ? { detached: true } : {}),
      });

      expect(summary.commit.committed).toBe(true);
      expect(await store.listSuspensions(SESSION_ID)).toHaveLength(1);
      expect(eventTypes).toContain("turn.suspended");
      expect(eventTypes).not.toContain("turn.completed");
    },
  );
});
