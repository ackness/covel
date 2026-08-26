import { createEventBus } from "@covel/events";
import type {
  FunctionHandler,
  FunctionHandlerContext,
  LoadedRuntime,
} from "@covel/plugin-loader";
import type { RuntimeManifest } from "@covel/shared";
import { createMemoryStore } from "@covel/store";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createInProcessSessionLock,
  type SessionLock,
} from "../../src/lib/session-lock.js";
import { createPluginRpcRuntimeTurnRunner } from "../../src/routes/api/plugin-rpc/runtime-turn.js";
import {
  rotateSessionApprovalScope,
  sessionApprovalScope,
} from "../../src/routes/api/session/session-guard.js";

const SESSION_ID = "sess-background-lock";
const PLUGIN_ID = "image-plugin";
const RUNTIME_A = `${PLUGIN_ID}/generator-a`;
const RUNTIME_B = `${PLUGIN_ID}/generator-b`;

function manifest(name: string): RuntimeManifest {
  return {
    name,
    pluginId: PLUGIN_ID,
    description: name,
    runtimeType: "function",
    handler: "./handler.js",
    execution: "background",
    trigger: { type: "event", topic: "image.generate" },
  };
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve = (): void => undefined;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function trackingLock(): {
  lock: SessionLock;
  requestedKeys: string[];
} {
  const inner = createInProcessSessionLock();
  const requestedKeys: string[] = [];
  return {
    requestedKeys,
    lock: {
      withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
        requestedKeys.push(key);
        return inner.withLock(key, fn);
      },
      withLocks<T>(keys: readonly string[], fn: () => Promise<T>): Promise<T> {
        requestedKeys.push(...keys);
        return inner.withLocks(keys, fn);
      },
    },
  };
}

describe("detached runtime cross-process lock boundary", () => {
  const runtimes = [manifest(RUNTIME_A), manifest(RUNTIME_B)];

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  async function setup(handler: FunctionHandler) {
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
    const { lock, requestedKeys } = trackingLock();
    const session = await store.getSession(SESSION_ID);
    if (!session) throw new Error("expected session");
    const runner = createPluginRpcRuntimeTurnRunner({
      store,
      eventBus: createEventBus(store),
      sessionLock: lock,
      sessionId: SESSION_ID,
      session: { locale: "en" },
      activeRuntimes: runtimes,
      approvalScopes: new Map([
        [PLUGIN_ID, sessionApprovalScope(session, PLUGIN_ID)],
      ]),
      deps: {
        loadRuntime: async (runtime): Promise<LoadedRuntime> => ({
          manifest: runtime,
          promptTemplate: "",
          handler,
        }),
        llm: { generate: vi.fn() },
      } as unknown as Parameters<
        typeof createPluginRpcRuntimeTurnRunner
      >[0]["deps"],
    });
    return { runner, lock, requestedKeys, store, session };
  }

  const triggerEvent = {
    topic: "image.generate",
    data: { prompt: "same image", variant: "day" },
  };

  it("serializes the same runtime while leaving the session commit key free", async () => {
    const firstGate = deferred();
    let calls = 0;
    let active = 0;
    let maxActive = 0;
    const handler: FunctionHandler = async () => {
      calls++;
      active++;
      maxActive = Math.max(maxActive, active);
      if (calls === 1) await firstGate.promise;
      active--;
      return { ok: true };
    };
    const { runner, lock, requestedKeys } = await setup(handler);

    const first = runner.runDeferredFollowerTurn({
      followerTurnId: "follower-a-1",
      runtimeId: RUNTIME_A,
      triggerEvent,
    });
    await vi.waitFor(() => expect(calls).toBe(1));
    const second = runner.runDeferredFollowerTurn({
      followerTurnId: "follower-a-2",
      runtimeId: RUNTIME_A,
      triggerEvent: {
        topic: "image.generate",
        data: { variant: "day", prompt: "same image" },
      },
    });

    await lock.withLock(SESSION_ID, async () => undefined);
    expect(calls).toBe(1);
    firstGate.resolve();
    await Promise.all([first, second]);

    expect(calls).toBe(2);
    expect(maxActive).toBe(1);
    const backgroundKeys = requestedKeys.filter((key) =>
      key.startsWith("background-runtime:"),
    );
    expect(backgroundKeys).toHaveLength(2);
    expect(new Set(backgroundKeys).size).toBe(1);
    expect(backgroundKeys[0]).not.toBe(SESSION_ID);
  });

  it("rejects detached work before execution when approval was revoked", async () => {
    const handler = vi.fn<FunctionHandler>(async () => ({ ok: true }));
    const { runner, store, session } = await setup(handler);
    await store.updateSession(SESSION_ID, {
      metadata: rotateSessionApprovalScope(session, PLUGIN_ID),
      updatedAt: new Date().toISOString(),
    });

    await expect(
      runner.runManualTurn({
        turnId: "turn-revoked-before-run",
        runtimeId: RUNTIME_A,
        detached: true,
      }),
    ).rejects.toMatchObject({ name: "SessionApprovalScopeChangedError" });
    expect(handler).not.toHaveBeenCalled();
  });

  it("discards detached results when approval changes during execution", async () => {
    const started = deferred();
    const finish = deferred();
    const handler: FunctionHandler = async () => {
      started.resolve();
      await finish.promise;
      return { ok: true };
    };
    const { runner, store, session } = await setup(handler);
    const running = runner.runManualTurn({
      turnId: "turn-revoked-before-commit",
      runtimeId: RUNTIME_A,
      detached: true,
    });
    await started.promise;
    await store.updateSession(SESSION_ID, {
      metadata: rotateSessionApprovalScope(session, PLUGIN_ID),
      updatedAt: new Date().toISOString(),
    });
    finish.resolve();

    await expect(running).rejects.toMatchObject({
      name: "SessionApprovalScopeChangedError",
    });
  });

  it("serializes different activations of one runtime while allowing other runtimes", async () => {
    const gate = deferred();
    const started = new Set<string>();
    let active = 0;
    let maxActive = 0;
    const handler: FunctionHandler = async (ctx: FunctionHandlerContext) => {
      started.add(`${ctx.runtimeId}:${String(ctx.triggerEvent?.data.prompt)}`);
      active++;
      maxActive = Math.max(maxActive, active);
      await gate.promise;
      active--;
      return { ok: true };
    };
    const { runner } = await setup(handler);

    const first = runner.runDeferredFollowerTurn({
      followerTurnId: "follower-a-1",
      runtimeId: RUNTIME_A,
      triggerEvent,
    });
    const second = runner.runDeferredFollowerTurn({
      followerTurnId: "follower-a-2",
      runtimeId: RUNTIME_A,
      triggerEvent: {
        topic: "image.generate",
        data: { prompt: "different image" },
      },
    });
    const third = runner.runDeferredFollowerTurn({
      followerTurnId: "follower-b",
      runtimeId: RUNTIME_B,
      triggerEvent,
    });
    await vi.waitFor(() => expect(started.size).toBe(2));

    expect(started).toEqual(
      new Set([`${RUNTIME_A}:same image`, `${RUNTIME_B}:same image`]),
    );
    expect(maxActive).toBe(2);
    gate.resolve();
    await Promise.all([first, second, third]);
    expect(started).toContain(`${RUNTIME_A}:different image`);
    expect(maxActive).toBe(2);
  });
});
