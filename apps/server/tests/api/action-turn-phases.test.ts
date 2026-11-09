/**
 * Player-turn phases without HTTP: each phase runs against a memory store, a
 * fake host and a fake SSE sink, through the same stream and ledger the
 * action route builds.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { createEventBus } from "@covel/events";
import { createPluginRegistry } from "@covel/plugin-loader";
import {
  createInteractionSubmitter,
  createTraceRecorder,
  type TraceRecorder,
} from "@covel/runtime";
import type { ValidatedActionRequest } from "@covel/shared";
import type { SessionRecord } from "@covel/store";
import { createMemoryStore } from "@covel/store/memory";
import {
  createActionStream,
  type ActionStreamSink,
} from "../../src/routes/api/actions/action-stream.js";
import { createRequestLedger } from "../../src/routes/api/actions/request-ledger.js";
import { announceSettledTurn } from "../../src/routes/api/actions/turn-announcement.js";
import type { CommittedTurn } from "../../src/routes/api/actions/turn-commit.js";
import { prepareLockedTurn } from "../../src/routes/api/actions/turn-preparation.js";
import type {
  ActionTurnRequest,
  TurnArgs,
  TurnHost,
} from "../../src/routes/api/actions/turn-request.js";
import {
  registerActionRequest,
  type ActionRequestControl,
} from "../../src/routes/api/turn-control.js";

const SESSION_ID = "phase-session";
const REQUEST_ID = "phase-request";
const TURN_ID = "phase-turn";

interface Envelope {
  readonly type: string;
  readonly turnId: string;
  readonly payload: Record<string, unknown>;
}

function unexpected(call: string): never {
  throw new Error(`unexpected host call: ${call}`);
}

function fakeHost(overrides: Partial<TurnHost> = {}): TurnHost {
  return {
    workSignal: undefined,
    readLiveSession: async () => unexpected("readLiveSession"),
    preflightActionApprovals: async () => undefined,
    preflightFormApprovals: async () => undefined,
    prepareToolsForSession: undefined,
    executorDeps: () => unexpected("executorDeps"),
    hookPipeline: undefined,
    memorySystem: undefined,
    pluginExtensions: undefined,
    jobServices: () => undefined,
    jobCredentials: undefined,
    announceDeferredJobs: async () => {},
    announceQueuedJobs: () => {},
    withSettledLock: (run) => run(),
    withSessionLock: (run) => run(),
    retryPendingDimensionSettlements: async () => {},
    logRequestError: () => {},
    ...overrides,
  };
}

function sessionRecord(phase: SessionRecord["phase"]): SessionRecord {
  const now = new Date().toISOString();
  return {
    id: SESSION_ID,
    status: "active",
    phase,
    locale: "en",
    activePlugins: [],
    setupRuntimes: {},
    seats: [
      { id: "main", controller: "human", role: "player", characters: "auto" },
    ],
    completedPlayerTurns: 1,
    metadata: {},
    createdAt: now,
    updatedAt: now,
  };
}

const controls: ActionRequestControl[] = [];
afterEach(() => {
  for (const control of controls.splice(0)) control.release();
  vi.restoreAllMocks();
});

async function turnContext(
  options: {
    readonly host?: TurnHost;
    readonly isRuntimeRetry?: boolean;
  } = {},
) {
  const store = createMemoryStore();
  const session = sessionRecord("playing");
  await store.createSession(session);
  const eventBus = createEventBus();
  const written: Envelope[] = [];
  const sink: ActionStreamSink = {
    aborted: false,
    async writeSSE(message) {
      written.push(JSON.parse(String(message.data)) as Envelope);
    },
    abort() {},
    onAbort() {},
  };
  const body: ValidatedActionRequest = {
    requestId: REQUEST_ID,
    type: "start_session",
    sessionId: SESSION_ID,
    payload: {},
  };
  const stream = createActionStream({
    sink,
    requestId: REQUEST_ID,
    sessionId: SESSION_ID,
    turnId: TURN_ID,
    eventBus,
  });
  const control = registerActionRequest(SESSION_ID, TURN_ID, REQUEST_ID);
  controls.push(control);
  const ledger = createRequestLedger({
    store,
    stream,
    control,
    eventBus,
    request: body,
  });
  const request: ActionTurnRequest = {
    store,
    pluginRegistry: createPluginRegistry(),
    eventBus,
    mediaStore: undefined,
    body,
    session,
    turnId: TURN_ID,
    playerSettings: undefined,
    submitInteraction: createInteractionSubmitter(undefined, store),
    locale: "en",
    isRuntimeRetry: options.isRuntimeRetry ?? false,
    host: options.host ?? fakeHost(),
  };
  const phase = (turn: TurnArgs) => ({ request, stream, ledger, turn });
  return { store, eventBus, stream, ledger, written, phase };
}

function committedTurn(
  trace: TraceRecorder,
  overrides: Partial<CommittedTurn> = {},
): CommittedTurn {
  return {
    stopped: false,
    result: {
      turnId: TURN_ID,
      sessionId: SESSION_ID,
      runtimeResults: [],
      executionContext: {
        executionId: "execution",
        origin: "player",
        countPolicy: "complete-player-turn",
      },
      durationMs: 12,
      timestamp: new Date().toISOString(),
    },
    trace,
    committed: true,
    commitError: undefined,
    fanOutFailed: false,
    wasPreGamePending: true,
    stopReason: "no-eligible-story",
    replaysPlayerInput: false,
    queuedRuntimeJobs: [],
    followerJobs: [],
    ...overrides,
  };
}

const playerTurn: TurnArgs = {
  turnId: TURN_ID,
  suppressPlayerMessage: true,
  origin: "player",
};

describe("post-commit announcement", () => {
  it("records the settled turn and asks for a resync when an announcement fails", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const ctx = await turnContext({
      host: fakeHost({
        announceDeferredJobs: async () => {
          throw new Error("worker unavailable");
        },
      }),
    });
    ctx.ledger.markTurnStarted();
    const trace = createTraceRecorder(
      ctx.store,
      SESSION_ID,
      TURN_ID,
      ctx.stream.traceId,
    );

    const outcome = await announceSettledTurn(
      ctx.phase(playerTurn),
      committedTurn(trace),
    );
    await ctx.stream.flush();

    // Setup finished with this commit: the opening continuation follows.
    expect(outcome).toEqual({
      stopReason: "no-eligible-story",
      resultCount: 0,
      durationMs: 12,
      committed: true,
      fanOutFailed: false,
      continues: true,
    });
    expect(ctx.ledger.resyncRequired).toBe(true);
    expect(ctx.ledger.lastSettled).toEqual({
      turnId: TURN_ID,
      runtimeCount: 0,
      outcome,
    });
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("announcing deferred jobs"),
      expect.any(Error),
    );
    const traces = await ctx.store.queryTraceEvents(SESSION_ID, {
      turnId: TURN_ID,
    });
    expect(traces.map((event) => event.type).sort()).toEqual([
      "execution.round.completed",
      "turn.completed",
    ]);
    expect(
      traces.find((event) => event.type === "execution.round.completed")
        ?.payload,
    ).toMatchObject({ committed: true, resyncRequired: true });
    expect(ctx.written).toHaveLength(1);
    expect(ctx.written[0]).toMatchObject({
      type: "execution.round.completed",
      turnId: TURN_ID,
      payload: { requestId: REQUEST_ID, committed: true, resyncRequired: true },
    });

    // A round is reported once per turn.
    await ctx.ledger.reportRound(outcome);
    await ctx.stream.flush();
    expect(ctx.written).toHaveLength(1);
  });

  it("does not continue into the opening after a runtime retry", async () => {
    const ctx = await turnContext({ isRuntimeRetry: true });
    const trace = createTraceRecorder(ctx.store, SESSION_ID, TURN_ID);

    const outcome = await announceSettledTurn(
      ctx.phase(playerTurn),
      committedTurn(trace),
    );

    expect(outcome.continues).toBe(false);
    expect(ctx.ledger.resyncRequired).toBe(false);
    // Not started under this ledger: nothing reports a round.
    expect(ctx.written).toEqual([]);
  });
});

describe("turn preparation for an auto-advanced round", () => {
  const advancedRound: TurnArgs = {
    turnId: "advanced-turn",
    suppressPlayerMessage: true,
    origin: "continuation",
    generated: true,
  };

  it("refuses the round once the live session left play, before anything starts", async () => {
    const ctx = await turnContext({
      host: fakeHost({ readLiveSession: async () => sessionRecord("setup") }),
    });

    const prepared = await prepareLockedTurn(ctx.phase(advancedRound));
    ctx.eventBus.emit({
      id: crypto.randomUUID(),
      type: "event",
      topic: "plugin",
      sessionId: SESSION_ID,
      timestamp: new Date().toISOString(),
      payload: { _subType: "plugin-data.changed" },
    });
    await ctx.stream.flush();

    expect(prepared).toEqual({ stopped: true });
    expect(ctx.ledger.autoStartRefusal).toBe("session-unavailable");
    // The input clock is not frozen and no bus event is forwarded.
    expect(ctx.ledger.root.logicalTurn).toBeUndefined();
    expect(ctx.written).toEqual([]);
  });

  it("reports a missing approval on the stream and refuses the round", async () => {
    const ctx = await turnContext({
      host: fakeHost({
        readLiveSession: async () => sessionRecord("playing"),
        preflightActionApprovals: async () =>
          Response.json(
            { error: "Plugin approval is required", code: "approval_required" },
            { status: 403 },
          ),
      }),
    });

    const prepared = await prepareLockedTurn(ctx.phase(advancedRound));
    await ctx.stream.flush();

    expect(prepared).toEqual({ stopped: true });
    expect(ctx.ledger.autoStartRefusal).toBe("prerequisite-unavailable");
    expect(ctx.ledger.hasStartedTurn).toBe(false);
    expect(ctx.written).toEqual([
      expect.objectContaining({
        type: "error.occurred",
        turnId: TURN_ID,
        payload: {
          message: "Plugin approval is required",
          code: "approval_required",
        },
      }),
    ]);
  });
});
