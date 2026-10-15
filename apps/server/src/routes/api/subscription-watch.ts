import type { EventBus } from "@covel/events";
import type { SubscriptionEvent } from "@covel/shared";
import { SSE_WRITE_QUEUE_MAX } from "./sse-delivery.js";

type Reset = Parameters<Parameters<NonNullable<EventBus["onReset"]>>[0]>[0];

/** Observe before reading authorization; hand the bounded handshake buffer to SSE. */
export function watchSubscription(bus: EventBus, sessionId: string) {
  const pending: SubscriptionEvent[] = [];
  let reset: Reset | undefined;
  let receive: ((event: SubscriptionEvent) => void) | undefined;
  let receiveReset: ((event: Reset) => void) | undefined;
  const off = bus.onEmit((event) => {
    if (event.sessionId !== sessionId) return;
    if (receive) receive(event);
    else if (pending.length < SSE_WRITE_QUEUE_MAX) pending.push(event);
    else reset = { sessionId, reason: "transport-gap" };
  });
  const offReset = bus.onReset?.((event) => {
    if (event.sessionId !== sessionId) return;
    if (receiveReset) receiveReset(event);
    else reset = event;
  });
  let pin: ReturnType<EventBus["pin"]>;
  try {
    pin = bus.pin(sessionId);
  } catch (error) {
    off();
    offReset?.();
    throw error;
  }
  let closed = false;
  return {
    epoch: pin.epoch,
    activate(
      onEvent: (event: SubscriptionEvent) => void,
      onReset: (event: Reset) => void,
    ) {
      receive = onEvent;
      receiveReset = onReset;
      if (reset) onReset(reset);
      for (const event of pending.splice(0)) onEvent(event);
    },
    close() {
      if (closed) return;
      closed = true;
      off();
      offReset?.();
      pin.release();
      pending.length = 0;
    },
  };
}
