/**
 * Event bus — publish/subscribe with topic matching.
 * Optionally persists events to a DataStore for audit trail.
 */

import type { CovelMessage, SubscriptionEvent } from '@covel/shared';
import type { DataStore, EventRecord } from '@covel/store';

export type EventHandler = (message: CovelMessage) => void | Promise<void>;

export interface EventBus {
  /** Publish an event. */
  emit(message: CovelMessage): void;
  /** Subscribe to a topic. Returns unsubscribe function. */
  on(topic: string, handler: EventHandler): () => void;
  /** One-time subscription. */
  once(topic: string, handler: EventHandler): () => void;
  /** Get pending (unacknowledged) events for a session. */
  getPendingEvents(sessionId: string): readonly CovelMessage[];
  /** Acknowledge (consume) an event. */
  acknowledge(messageId: string): void;
  /** Clear all events for a session. */
  clearSession(sessionId: string): void;
  /** Get subscription events after a given sequence number for replay. */
  getEventsAfter(sessionId: string, afterSeq: number): SubscriptionEvent[];
  /** Register a callback for every emitted event (as SubscriptionEvent). Returns unsubscribe function. */
  onEmit(callback: (event: SubscriptionEvent) => void): () => void;
}

const RING_BUFFER_MAX = 1000;

export function createEventBus(store?: DataStore): EventBus {
  const handlers = new Map<string, Set<EventHandler>>();
  const pendingEvents = new Map<string, Map<string, CovelMessage>>();
  // Reverse lookup: messageId → sessionId for O(1) acknowledge
  const messageSession = new Map<string, string>();

  // ── Subscription infrastructure ────────────────────────────────
  // Per-session monotonic sequence counter
  const sessionSeqCounters = new Map<string, number>();
  // Per-session ring buffer of recent SubscriptionEvents
  const sessionEventBuffers = new Map<string, SubscriptionEvent[]>();
  // Global onEmit callbacks
  const emitCallbacks = new Set<(event: SubscriptionEvent) => void>();

  function nextSeq(sessionId: string): number {
    const current = sessionSeqCounters.get(sessionId) ?? 0;
    const next = current + 1;
    sessionSeqCounters.set(sessionId, next);
    return next;
  }

  function appendToBuffer(sessionId: string, event: SubscriptionEvent): void {
    let buffer = sessionEventBuffers.get(sessionId);
    if (!buffer) {
      buffer = [];
      sessionEventBuffers.set(sessionId, buffer);
    }
    buffer.push(event);
    // Trim ring buffer to max size
    if (buffer.length > RING_BUFFER_MAX) {
      const overflow = buffer.length - RING_BUFFER_MAX;
      buffer.splice(0, overflow);
    }
  }

  function getOrCreateHandlers(topic: string): Set<EventHandler> {
    let set = handlers.get(topic);
    if (!set) {
      set = new Set();
      handlers.set(topic, set);
    }
    return set;
  }

  function getOrCreateSessionPending(sessionId: string): Map<string, CovelMessage> {
    let map = pendingEvents.get(sessionId);
    if (!map) {
      map = new Map();
      pendingEvents.set(sessionId, map);
    }
    return map;
  }

  function notifyHandlers(topic: string, message: CovelMessage): void {
    const topicHandlers = handlers.get(topic);
    if (topicHandlers) {
      for (const handler of [...topicHandlers]) {
        handler(message);
      }
    }
  }

  function persistEvent(message: CovelMessage): void {
    if (!store) return;

    const record: EventRecord = {
      id: message.id,
      sessionId: message.sessionId,
      type: message.type,
      topic: message.topic,
      payload: message.payload,
      targetRuntime: message.targetRuntime,
      turnId: message.turnId,
      createdAt: message.timestamp,
    };

    // Fire-and-forget: persistence is for audit trail, not blocking emit
    void store.saveEvent(record);
  }

  const bus: EventBus = {
    emit(message: CovelMessage): void {
      // Notify topic-specific handlers
      notifyHandlers(message.topic, message);
      // Notify wildcard handlers (unless the topic itself is '*')
      if (message.topic !== '*') {
        notifyHandlers('*', message);
      }
      // Add to pending events (in-memory for real-time trigger routing)
      const sessionPending = getOrCreateSessionPending(message.sessionId);
      sessionPending.set(message.id, message);
      messageSession.set(message.id, message.sessionId);

      // ── Subscription event creation ──────────────────────────
      const seq = nextSeq(message.sessionId);
      // Allow payload to carry explicit subscription topic/type overrides
      const payload = message.payload;
      const subTopic = (typeof payload._subTopic === 'string' ? payload._subTopic : message.topic) as SubscriptionEvent['topic'];
      const subType = typeof payload._subType === 'string' ? payload._subType : message.topic;
      // Strip internal fields from the exposed payload
      const { _subTopic: _t, _subType: _s, ...cleanPayload } = payload as Record<string, unknown>;
      const subEvent: SubscriptionEvent = {
        id: String(seq),
        topic: subTopic,
        type: subType,
        sessionId: message.sessionId,
        timestamp: message.timestamp,
        payload: cleanPayload,
      };
      appendToBuffer(message.sessionId, subEvent);
      for (const cb of emitCallbacks) {
        cb(subEvent);
      }

      // Persist to store for audit trail
      persistEvent(message);
    },

    on(topic: string, handler: EventHandler): () => void {
      const set = getOrCreateHandlers(topic);
      set.add(handler);
      return () => {
        set.delete(handler);
      };
    },

    once(topic: string, handler: EventHandler): () => void {
      const wrappedHandler: EventHandler = (message) => {
        set.delete(wrappedHandler);
        handler(message);
      };
      const set = getOrCreateHandlers(topic);
      set.add(wrappedHandler);
      return () => {
        set.delete(wrappedHandler);
      };
    },

    getPendingEvents(sessionId: string): readonly CovelMessage[] {
      const sessionPending = pendingEvents.get(sessionId);
      if (!sessionPending) {
        return [];
      }
      return [...sessionPending.values()];
    },

    acknowledge(messageId: string): void {
      const sessionId = messageSession.get(messageId);
      if (sessionId === undefined) {
        return;
      }
      const sessionPending = pendingEvents.get(sessionId);
      if (sessionPending) {
        sessionPending.delete(messageId);
      }
      messageSession.delete(messageId);
    },

    clearSession(sessionId: string): void {
      const sessionPending = pendingEvents.get(sessionId);
      if (sessionPending) {
        for (const msgId of sessionPending.keys()) {
          messageSession.delete(msgId);
        }
        pendingEvents.delete(sessionId);
      }
    },

    getEventsAfter(sessionId: string, afterSeq: number): SubscriptionEvent[] {
      const buffer = sessionEventBuffers.get(sessionId);
      if (!buffer || buffer.length === 0) {
        return [];
      }
      return buffer.filter((event) => parseInt(event.id, 10) > afterSeq);
    },

    onEmit(callback: (event: SubscriptionEvent) => void): () => void {
      emitCallbacks.add(callback);
      return () => {
        emitCallbacks.delete(callback);
      };
    },
  };

  return bus;
}
