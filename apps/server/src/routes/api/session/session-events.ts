import type { EventBus } from "@covel/events";
import type { SessionRecord } from "@covel/store";
import { publicSessionIncarnation } from "./session-guard.js";

/** Capture once, before work starts. Delayed producers keep their original audience. */
export function sessionEventBus(
  bus: EventBus,
  session: SessionRecord,
): EventBus {
  return scopeSessionEvents(bus, session.id, publicSessionIncarnation(session));
}

export function scopeSessionEvents(
  bus: EventBus,
  sessionId: string,
  incarnation: string,
): EventBus {
  return {
    ...bus,
    onEmit(callback) {
      return bus.onEmit((event) => {
        if (
          event.sessionId === sessionId &&
          event.sessionIncarnation === incarnation
        )
          callback(event);
      });
    },
    emit(message) {
      if (!incarnation) {
        bus.rejectEmission("Session event producer has no incarnation");
        return;
      }
      if (message.sessionId !== sessionId) {
        bus.rejectEmission("Session event producer changed its audience");
        return;
      }
      if (
        message.sessionIncarnation !== undefined &&
        message.sessionIncarnation !== incarnation
      ) {
        bus.rejectEmission(
          "Session event producer cannot relabel another incarnation",
        );
        return;
      }
      bus.emit({ ...message, sessionIncarnation: incarnation });
    },
  };
}

/** A lifecycle control event uses the same ordered outbox as ordinary events. */
export function invalidateSessionEvents(
  bus: EventBus,
  session: SessionRecord,
): void {
  sessionEventBus(bus, session).emit({
    id: crypto.randomUUID(),
    type: "event",
    topic: "system",
    sessionId: session.id,
    timestamp: new Date().toISOString(),
    payload: { _subType: "session.invalidated" },
  });
}
