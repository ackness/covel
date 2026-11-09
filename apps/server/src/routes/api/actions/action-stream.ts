/**
 * The SSE stream of one action request.
 *
 * It owns what every event written to the stream shares: the envelope
 * identity (request, trace, session, the turn currently writing), sequence
 * numbers, the bounded write queue, story drafts, and the forwarding of
 * session bus events while a turn holds the session lock. Turn logic writes
 * through it and never touches the transport directly.
 */

import type { SSEStreamingApi } from "hono/streaming";
import type { EventBus } from "@covel/events";
import type { OutputDraftSink } from "@covel/runtime";
import {
  FORWARDED_EVENT_TYPES,
  isRuntimeProgressType,
  type CovelEventType,
  type RuntimeRetryScope,
  type SseEnvelope,
} from "@covel/shared";
import { executionProgressPayload } from "../execution-progress.js";
import { createOutputDraftDelivery } from "../output-draft-delivery.js";
import {
  createBoundedSerialQueue,
  SSE_WRITE_QUEUE_MAX,
} from "../sse-delivery.js";

/** The part of the SSE transport the action stream writes to. */
export type ActionStreamSink = Pick<
  SSEStreamingApi,
  "writeSSE" | "abort" | "onAbort" | "aborted"
>;

export interface ActionStreamOptions {
  readonly sink: ActionStreamSink;
  readonly requestId: string;
  readonly sessionId: string;
  /** The request's first turn, which envelopes name until another starts. */
  readonly turnId: string;
  /** The session-scoped bus whose events a turn forwards. */
  readonly eventBus: EventBus;
  /** Defaults to a fresh id; also the envelopes' `flowId`. */
  readonly traceId?: string;
}

export interface ActionStream {
  readonly requestId: string;
  readonly sessionId: string;
  readonly traceId: string;
  /** The turn currently writing to this stream: the envelopes' default. */
  readonly turnId: string;
  /** The current turn's retry scope, merged into that turn's payloads. */
  readonly retryScope: RuntimeRetryScope | undefined;
  /** Make `turnId` the turn that envelopes name by default. */
  enterTurn(turnId: string): void;
  setRetryScope(scope: RuntimeRetryScope | undefined): void;
  /**
   * Take the event's place in the stream now, with its payload snapshotted;
   * never rejects. A payload that cannot be serialized aborts the stream.
   */
  write(
    type: string,
    payload: Record<string, unknown>,
    turnId?: string,
  ): Promise<void>;
  /** Story drafts: order fixed on arrival, content read when written. */
  readonly outputDrafts: OutputDraftSink;
  /** Forward the session's bus events until `stopForwarding`. */
  forwardBusEvents(): void;
  stopForwarding(): void;
  /** Wait for queued writes, then refuse further ones. */
  flush(): Promise<void>;
}

export function createActionStream(options: ActionStreamOptions): ActionStream {
  const { sink, requestId, sessionId, eventBus } = options;
  const traceId = options.traceId ?? crypto.randomUUID();
  let seq = 0;
  // The turn currently writing to this stream. The opening-continuation
  // turn reuses the stream under its own fresh turnId.
  let currentTurnId = options.turnId;
  let currentRetryScope: RuntimeRetryScope | undefined;

  function makeEnvelope(
    eventType: string,
    eventPayload: Record<string, unknown>,
    eventTurnId = currentTurnId,
  ): SseEnvelope {
    return {
      type: eventType,
      requestId,
      traceId,
      sessionId,
      turnId: eventTurnId,
      flowId: traceId,
      seq: seq++,
      timestamp: new Date().toISOString(),
      payload: {
        ...eventPayload,
        ...(eventTurnId === currentTurnId ? currentRetryScope : {}),
      },
    };
  }

  // Envelope identity/order is captured inside ownership, but observation
  // never waits inside the business lock or propagates into runtime retry.
  const writes = createBoundedSerialQueue({
    capacity: SSE_WRITE_QUEUE_MAX,
    onOverflow: () => sink.abort(),
    onError: () => sink.abort(),
  });
  sink.onAbort(() => writes.close());
  if (sink.aborted) writes.close();
  const write = (
    eventType: string,
    eventPayload: Record<string, unknown>,
    eventTurnId = currentTurnId,
  ): Promise<void> => {
    try {
      // Snapshot payloads as well as identity before later business mutations.
      const data = JSON.stringify(
        makeEnvelope(eventType, eventPayload, eventTurnId),
      );
      writes.enqueue(() => sink.writeSSE({ data }));
    } catch {
      writes.close();
      sink.abort();
    }
    return Promise.resolve();
  };
  // Story drafts: order fixed on arrival, content read when written, so a
  // slow reader receives the latest draft instead of every one.
  const outputDrafts = createOutputDraftDelivery((eventType, payload) => {
    const envelope = makeEnvelope(eventType, {});
    writes.enqueue(() => {
      const latest = payload();
      if (!latest) return Promise.resolve();
      const data = JSON.stringify({
        ...envelope,
        payload: { ...latest, ...envelope.payload },
      });
      return sink.writeSSE({ data });
    });
  });

  // Subscribe to out-of-band eventBus events (e.g. plugin-data.changed from
  // store proxy writes) and forward them to the action SSE stream. Without
  // this, events emitted by tool calls during the turn never reach the
  // frontend and UI state (character panel, codex, etc.) desyncs.
  //
  // Note: EventBus strips `_subType` from the raw payload and puts it on
  // `event.type`. So we whitelist by `event.type`, not by payload fields.
  // `turn.suspended` / `turn.resumed` must ride this whitelist too: they
  // are emitted through `emitSubEvent` (via the shared eventBus) rather
  // than through the `onRuntimeStart` / `onRuntimeComplete` callbacks, so
  // without this the action stream never delivers them to the web client
  // and the suspend/resume panel in the UI stays empty.
  //
  // The whitelist is DERIVED from the `CovelEvent` union via
  // `COVEL_EVENT_META[type].forwardToActionStream` (see
  // packages/shared/src/types/protocol.ts) — never hand-maintained here. Add
  // a forwarded event by flipping its meta flag; this Set updates for free.
  // `ev.type` is an untrusted runtime string, so it is narrowed at this
  // boundary before the membership check.
  //
  // The subscription's lifetime is exactly the session-lock tenure: it is
  // established INSIDE the lock (see the turn preparation) and torn down
  // while the lock is still held. Subscribing before the lock meant a second
  // action queued on the same session received the FIRST action's events
  // while waiting; unsubscribing after release (previously in the outer
  // finally) meant the reverse — once the next action acquired the lock,
  // this stream was still subscribed and wrapped the NEW turn's events in
  // the OLD turnId/traceId envelope. Bus events emitted outside this turn's
  // lock tenure (e.g. by deferred followers scheduled in the post-lock tail)
  // reach clients via the /api/events/stream subscription channel, not this
  // per-turn stream.
  let eventBusUnsubscribe: (() => void) | undefined;
  const forwardBusEvents = (): void => {
    eventBusUnsubscribe = eventBus.onEmit((ev) => {
      if (ev.sessionId !== sessionId) return;
      // The trace copy already drives this POST; the public copy is for subscriptions.
      if (ev.topic === "runtime" && isRuntimeProgressType(ev.type)) return;
      if (!FORWARDED_EVENT_TYPES.has(ev.type as CovelEventType)) return;
      const progress = executionProgressPayload(ev.type, {
        ...(ev.payload as Record<string, unknown>),
      });
      if (!progress) return;
      write(ev.type, progress).catch(() => {
        /* stream closed, teardown handles cleanup */
      });
    });
  };

  return {
    requestId,
    sessionId,
    traceId,
    get turnId() {
      return currentTurnId;
    },
    get retryScope() {
      return currentRetryScope;
    },
    enterTurn(turnId) {
      currentTurnId = turnId;
    },
    setRetryScope(scope) {
      currentRetryScope = scope;
    },
    write,
    outputDrafts,
    forwardBusEvents,
    stopForwarding() {
      eventBusUnsubscribe?.();
      eventBusUnsubscribe = undefined;
    },
    async flush() {
      await writes.drain();
      writes.close();
    },
  };
}
