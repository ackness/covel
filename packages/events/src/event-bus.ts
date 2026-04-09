/**
 * Event bus — publish/subscribe with topic matching.
 * Optionally persists events to a DataStore for audit trail.
 */

import type { CovelMessage } from '@covel/shared';
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
}

export function createEventBus(store?: DataStore): EventBus {
  const handlers = new Map<string, Set<EventHandler>>();
  const pendingEvents = new Map<string, Map<string, CovelMessage>>();
  // Reverse lookup: messageId → sessionId for O(1) acknowledge
  const messageSession = new Map<string, string>();

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
  };

  return bus;
}
