import { applyUiSlotEvent } from "@/stores/ui-slot-store.js";
import * as api from "@/services/api";
import {
  isRoutedEventType,
  routeSseEvent,
  type SseEventHandlerDeps,
} from "./sse-event-routes.js";

export {
  addBlockMessageFromSse,
  type SseEventHandlerDeps,
} from "./sse-event-routes.js";

export type SseEventHandler = (envelope: api.SseEnvelope) => void;

export function createSseEventHandler(
  deps: SseEventHandlerDeps,
): SseEventHandler {
  return (envelope) => {
    const { payload, turnId } = envelope;
    // Nothing aborts the previous action stream when the player switches
    // sessions mid-turn, so envelopes from the old session keep arriving on
    // the still-open connection. Every downstream write stamps
    // `sessionIdRef.current` (the NEW session), which in local/IDB mode
    // persists the old session's narrative into the new one's history. Drop
    // foreign envelopes before publishing any session state.
    const currentSessionId = deps.sessionIdRef.current;
    if (
      envelope.sessionId &&
      currentSessionId &&
      envelope.sessionId !== currentSessionId
    ) {
      return;
    }
    if (
      currentSessionId &&
      applyUiSlotEvent(currentSessionId, envelope.type, payload, turnId)
    )
      return;
    if (turnId && turnId !== deps.lastBackfilledTurnIdRef.current) {
      deps.lastBackfilledTurnIdRef.current = turnId;
    }

    // `SseEnvelope.type` is the raw, untrusted wire string. Every protocol
    // event type has an entry in `SSE_EVENT_ROUTES` (handled or explicitly
    // ignored); an unknown wire string is warned about, never silently dropped.
    const type = envelope.type;
    if (!isRoutedEventType(type)) {
      console.warn(`[sse-handler] unhandled SSE event type: ${type}`);
      return;
    }
    routeSseEvent({ type, deps, envelope, payload, turnId });
  };
}

export function applyResumeEvents(
  events: api.ResumeSuspensionResponse["events"],
  handleSseEvent: SseEventHandler,
): void {
  for (const event of events) {
    handleSseEvent({
      type: event.type,
      requestId: crypto.randomUUID(),
      traceId: event.turnId,
      sessionId: event.sessionId,
      turnId: event.turnId,
      flowId: event.turnId,
      seq: -1,
      timestamp: event.timestamp,
      payload: {
        ...event.payload,
        runtimeId: event.source.runtimeId,
        pluginId: event.source.pluginId,
      },
    });
  }
}
