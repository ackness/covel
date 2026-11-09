/**
 * What every phase of a player turn reads: the request it belongs to and the
 * host services it uses.
 *
 * The route builds both once per request. The host is the only part of turn
 * orchestration that reads the Hono context, so a phase can be tested with a
 * fake host and a memory store instead of an HTTP request.
 */

import type { Context, ContextVariableMap } from "hono";
import type { EventBus } from "@covel/events";
import type { MemorySystem } from "@covel/memory";
import type { PluginRegistry } from "@covel/plugin-loader";
import type {
  HookPipeline,
  PluginExtensionHost,
  createInteractionSubmitter,
} from "@covel/runtime";
import type { TurnInput, ValidatedActionRequest } from "@covel/shared";
import type { DataStore, MediaStore, SessionRecord } from "@covel/store";
import { logRequestError } from "../../../api-error.js";
import { preflightFormApprovals } from "../plugin-rpc/form-approvals.js";
import type {
  QueuedActivatedRuntimeJob,
  QueuedRuntimeJob,
} from "../plugin-rpc/runtime-job-enqueue.js";
import type { RuntimeJobServices } from "../plugin-rpc/runtime-job-credentials.js";
import {
  announceDeferredRuntimeJobs,
  announceQueuedRuntimeJobs,
  requestJobServices,
  withSettledExecutionLock,
} from "../plugin-rpc/settled-request.js";
import { readExecutionSession } from "../execution-context.js";
import { buildTurnExecutorDeps } from "../turn-execution-deps.js";
import { entryRejection } from "./action-rejection.js";
import type { ActionStream } from "./action-stream.js";
import { preflightActionApprovals } from "./approval-preflight.js";
import { retryPendingDimensionSettlements } from "./dimension-settlement-retry.js";
import type { RequestLedger } from "./request-ledger.js";

/** The request's host services. Each reads the Hono context when called. */
export interface TurnHost {
  /** Aborted when the server shuts down; closing the stream does not. */
  readonly workSignal: AbortSignal | undefined;
  /**
   * The session read under the lock. Refused (`ActionRejectedError`) unless
   * it is still the request's session incarnation, owned and active.
   */
  readLiveSession(): Promise<SessionRecord>;
  /** The approvals the action needs, as a refusal response or none. */
  preflightActionApprovals(
    session: SessionRecord,
  ): Promise<Response | undefined>;
  /** The approvals a form answer's validator needs. */
  preflightFormApprovals(
    session: SessionRecord,
    answers: unknown,
  ): Promise<Response | undefined>;
  /** Refresh the session's character-tool overrides; absent in some tests. */
  readonly prepareToolsForSession: ContextVariableMap["prepareToolsForSession"];
  executorDeps(): ReturnType<typeof buildTurnExecutorDeps>;
  readonly hookPipeline: HookPipeline | undefined;
  readonly memorySystem: MemorySystem | undefined;
  readonly pluginExtensions: PluginExtensionHost | undefined;
  /** Provider services a queued job may take from this request. */
  jobServices(): RuntimeJobServices | undefined;
  readonly jobCredentials:
    | Pick<
        NonNullable<ContextVariableMap["runtimeJobCredentials"]>,
        "register" | "discard"
      >
    | undefined;
  /** After the commit that queued them: publish and wake the worker. */
  announceDeferredJobs(
    queued: readonly QueuedRuntimeJob[],
    write: (payload: Record<string, unknown>) => Promise<void>,
  ): Promise<void>;
  announceQueuedJobs(queued: readonly QueuedActivatedRuntimeJob[]): void;
  /** Run under the session lock once earlier work settled; `stop` ends the wait. */
  withSettledLock<T>(run: () => Promise<T>, stop: AbortSignal): Promise<T>;
  /** Run under the session lock without waiting for earlier work to settle. */
  withSessionLock<T>(run: () => Promise<T>): Promise<T>;
  retryPendingDimensionSettlements(signal: AbortSignal): Promise<void>;
  logRequestError(message: string, error: unknown): void;
}

/** One action request, fixed before its first turn and read by every phase. */
export interface ActionTurnRequest {
  readonly store: DataStore;
  readonly pluginRegistry: PluginRegistry;
  /** The session-scoped bus. */
  readonly eventBus: EventBus;
  readonly mediaStore: MediaStore | undefined;
  readonly body: ValidatedActionRequest;
  /** The session as read before the stream opened; the lock re-reads it. */
  readonly session: SessionRecord;
  /** The request's first turn. */
  readonly turnId: string;
  /** The player's settings from the request, before world defaults. */
  readonly playerSettings: TurnInput["userSettings"];
  readonly submitInteraction: ReturnType<typeof createInteractionSubmitter>;
  /**
   * The content locale is fixed when the session is created. A request
   * cannot change it: switching the UI language mid-session changes labels,
   * not the language the story is written in.
   */
  readonly locale: string;
  /** A `retry_runtime` or `retry_failed_runtimes` request. */
  readonly isRuntimeRetry: boolean;
  readonly host: TurnHost;
}

/** One turn the request runs: its own, the opening, or an advanced round. */
export interface TurnArgs {
  readonly turnId: string;
  readonly suppressPlayerMessage: boolean;
  readonly origin: "player" | "continuation";
  /** An auto-advanced round, started by the request instead of the player. */
  readonly generated?: boolean;
}

/**
 * What each phase of one turn takes. Phases share nothing else: what one
 * phase hands the next is its typed result, and what the request keeps
 * across turns lives in the stream and the ledger.
 */
export interface TurnPhase {
  readonly request: ActionTurnRequest;
  readonly stream: ActionStream;
  readonly ledger: RequestLedger;
  readonly turn: TurnArgs;
}

/** The turn did not start; the request reports why through the ledger. */
export interface TurnStopped {
  readonly stopped: true;
}

/** The request's host services for its turns, read from `c`. */
export function createTurnHost(
  c: Context,
  request: {
    readonly store: DataStore;
    readonly body: ValidatedActionRequest;
    readonly session: SessionRecord;
    readonly playerSettings: TurnInput["userSettings"];
    readonly prepareToolsForSession: ContextVariableMap["prepareToolsForSession"];
  },
): TurnHost {
  const { store, body, session } = request;
  const sessionId = body.sessionId;
  return {
    get workSignal() {
      return c.get("requestWork")?.signal;
    },
    async readLiveSession() {
      const live = await readExecutionSession(c, {
        store,
        sessionId,
        expectedSession: session,
        signal: c.get("requestWork")?.signal,
      });
      // The stream is open: a refusal travels as `error.occurred`.
      if (live instanceof Response) throw await entryRejection(live);
      return live;
    },
    preflightActionApprovals: (live) => preflightActionApprovals(c, live, body),
    preflightFormApprovals: (live, answers) =>
      preflightFormApprovals(c, live, answers),
    prepareToolsForSession: request.prepareToolsForSession,
    executorDeps: () => buildTurnExecutorDeps(c),
    get hookPipeline() {
      return c.get("hookPipeline");
    },
    get memorySystem() {
      return c.get("memorySystem");
    },
    get pluginExtensions() {
      return c.get("pluginExtensions");
    },
    jobServices: () => requestJobServices(c),
    get jobCredentials() {
      return c.get("runtimeJobCredentials");
    },
    announceDeferredJobs: (queued, write) =>
      announceDeferredRuntimeJobs(c, queued, write),
    announceQueuedJobs: (queued) => announceQueuedRuntimeJobs(c, queued),
    withSettledLock: (run, stop) =>
      withSettledExecutionLock(c, sessionId, run, undefined, stop),
    withSessionLock: (run) => c.get("sessionLock").withLock(sessionId, run),
    retryPendingDimensionSettlements: (signal) =>
      retryPendingDimensionSettlements(c, {
        session,
        playerSettings: request.playerSettings,
        signal,
      }),
    logRequestError: (message, error) => logRequestError(c, message, error),
  };
}
