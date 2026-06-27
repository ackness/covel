/**
 * Shared event → store reducers for the two SSE channels.
 *
 * The framework delivers the same `CovelEvent` union on two independent
 * transports:
 *
 *   - the `/api/actions` turn-execution stream (`SseEnvelope`), handled in
 *     `sse-handler.ts`;
 *   - the persistent `/api/events/stream` subscription (`SubscriptionEvent`),
 *     handled in `subscription.ts`.
 *
 * A handful of events (`plugin-data.changed`, `turn.suspended`,
 * `turn.resumed`) arrive on BOTH transports and previously had the exact same
 * "event payload → store update" logic copied into each handler. These pure
 * reducers are that single shared implementation; each channel unpacks its own
 * transport envelope and calls into here, so the transport differences stay in
 * the channels while the business logic lives in one place.
 */

import {
  applyChanges as applyPluginDataStoreChanges,
  type PluginDataChange,
} from "@/stores/plugin-data-store.js";
import { buildResumedExecutionStep } from "./execution-steps.js";
import {
  collectJobTransitions,
  emitJobTransitionToast,
} from "./job-transitions.js";
import type { SessionDispatch, SuspensionRecord } from "./types.js";

/**
 * Envelope-level fallbacks the suspend/resume reducers need. The two channels
 * expose these fields differently (the actions stream carries them at the top
 * of `SseEnvelope`; the subscription stream only has `sessionId` / `timestamp`
 * and no top-level `turnId`), so each channel normalises into this shape.
 */
export interface EventContext {
  /** Envelope-level `sessionId` fallback when the payload omits one. */
  readonly sessionId: string;
  /** Envelope-level `timestamp` fallback when the payload omits one. */
  readonly timestamp: string;
  /**
   * Envelope-level `turnId` fallback. The actions stream provides this; the
   * subscription stream does not (pass `undefined`).
   */
  readonly turnId?: string;
}

/**
 * `plugin-data.changed`: mirror the change set into the plugin-data store,
 * notify the session reducer, and surface any job completed/failed toasts.
 */
export function reducePluginDataChanged(
  dispatch: SessionDispatch,
  payload: Readonly<Record<string, unknown>>,
): void {
  const pluginId = payload.pluginId as string | undefined;
  const changes = payload.changes as readonly PluginDataChange[] | undefined;
  if (!pluginId || !changes) return;
  const transitions = collectJobTransitions(pluginId, changes);
  dispatch({ type: "PLUGIN_DATA_CHANGED", pluginId, changes });
  applyPluginDataStoreChanges(pluginId, changes);
  for (const tr of transitions) emitJobTransitionToast(tr);
}

/**
 * `turn.suspended`: record the suspended runtime so the panel can render its
 * resume affordance. Reducer-level dedupe by id keeps double-delivery (the
 * same event on both transports) from stacking rows.
 */
export function reduceTurnSuspended(
  dispatch: SessionDispatch,
  payload: Readonly<Record<string, unknown>>,
  ctx: EventContext,
): void {
  const id = payload.suspensionId as string | undefined;
  if (!id) return;
  const suspension: SuspensionRecord = {
    id,
    sessionId: (payload.sessionId as string) ?? ctx.sessionId,
    turnId: (payload.turnId as string) ?? ctx.turnId ?? "",
    runtimeId: (payload.runtimeId as string) ?? "",
    pluginId: (payload.pluginId as string) ?? "",
    suspendedAt: (payload.suspendedAt as string) ?? ctx.timestamp,
    reason: payload.reason as string | undefined,
    resumeSchema: payload.resumeSchema,
  };
  dispatch({ type: "ADD_SUSPENSION", suspension });
}

/**
 * `turn.resumed`: upsert the resumed runtime's execution step (when the
 * payload carries enough to build one) and drop the suspension row.
 */
export function reduceTurnResumed(
  dispatch: SessionDispatch,
  payload: Readonly<Record<string, unknown>>,
  ctx: EventContext,
): void {
  const id = payload.suspensionId as string | undefined;
  if (!id) return;
  const resumedStep = buildResumedExecutionStep(payload, ctx.turnId);
  if (resumedStep) {
    dispatch({ type: "UPSERT_EXECUTION_STEP", step: resumedStep });
  }
  dispatch({ type: "REMOVE_SUSPENSION", suspensionId: id });
}
