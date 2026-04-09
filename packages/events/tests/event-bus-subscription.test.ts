import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { CovelMessage, SubscriptionEvent } from '@covel/shared';
import { createEventBus, type EventBus } from '../src/event-bus.js';

function makeMessage(overrides?: Partial<CovelMessage>): CovelMessage {
  return {
    id: crypto.randomUUID(),
    type: 'event',
    topic: 'test.topic',
    payload: {},
    sessionId: 'sess-1',
    timestamp: new Date().toISOString(),
    ...overrides,
  };
}

describe('EventBus Subscription Features', () => {
  let bus: EventBus;

  beforeEach(() => {
    bus = createEventBus();
  });

  describe('sequence numbering', () => {
    it('should assign incrementing sequence IDs to subscription events', () => {
      const events: SubscriptionEvent[] = [];
      bus.onEmit((event) => events.push(event));

      bus.emit(makeMessage({ sessionId: 'sess-1' }));
      bus.emit(makeMessage({ sessionId: 'sess-1' }));
      bus.emit(makeMessage({ sessionId: 'sess-1' }));

      expect(events).toHaveLength(3);
      expect(parseInt(events[0]!.id, 10)).toBeLessThan(parseInt(events[1]!.id, 10));
      expect(parseInt(events[1]!.id, 10)).toBeLessThan(parseInt(events[2]!.id, 10));
    });

    it('should use per-session sequence counters', () => {
      const events: SubscriptionEvent[] = [];
      bus.onEmit((event) => events.push(event));

      bus.emit(makeMessage({ sessionId: 'sess-1' }));
      bus.emit(makeMessage({ sessionId: 'sess-2' }));
      bus.emit(makeMessage({ sessionId: 'sess-1' }));

      const sess1Events = events.filter((e) => e.sessionId === 'sess-1');
      const sess2Events = events.filter((e) => e.sessionId === 'sess-2');

      expect(sess1Events).toHaveLength(2);
      expect(sess2Events).toHaveLength(1);
      // sess-1: first event should be seq 1, second should be seq 2
      expect(sess1Events[0]!.id).toBe('1');
      expect(sess1Events[1]!.id).toBe('2');
      // sess-2: first event should be seq 1
      expect(sess2Events[0]!.id).toBe('1');
    });
  });

  describe('getEventsAfter', () => {
    it('should return events after a given sequence number', () => {
      bus.emit(makeMessage({ sessionId: 'sess-1' }));
      bus.emit(makeMessage({ sessionId: 'sess-1' }));
      bus.emit(makeMessage({ sessionId: 'sess-1' }));

      const after1 = bus.getEventsAfter('sess-1', 1);
      expect(after1).toHaveLength(2);
      expect(after1[0]!.id).toBe('2');
      expect(after1[1]!.id).toBe('3');
    });

    it('should return empty array when no events after given seq', () => {
      bus.emit(makeMessage({ sessionId: 'sess-1' }));

      const result = bus.getEventsAfter('sess-1', 1);
      expect(result).toHaveLength(0);
    });

    it('should return empty array for unknown session', () => {
      const result = bus.getEventsAfter('unknown-session', 0);
      expect(result).toHaveLength(0);
    });

    it('should return all events when afterSeq is 0', () => {
      bus.emit(makeMessage({ sessionId: 'sess-1' }));
      bus.emit(makeMessage({ sessionId: 'sess-1' }));

      const all = bus.getEventsAfter('sess-1', 0);
      expect(all).toHaveLength(2);
    });
  });

  describe('onEmit', () => {
    it('should fire callback for every emitted event', () => {
      const callback = vi.fn();
      bus.onEmit(callback);

      bus.emit(makeMessage({ sessionId: 'sess-1' }));
      bus.emit(makeMessage({ sessionId: 'sess-2' }));

      expect(callback).toHaveBeenCalledTimes(2);
    });

    it('should provide a SubscriptionEvent with correct fields', () => {
      const events: SubscriptionEvent[] = [];
      bus.onEmit((event) => events.push(event));

      bus.emit(makeMessage({
        sessionId: 'sess-1',
        topic: 'quest.completed',
        payload: { questId: 'q-1' },
      }));

      expect(events).toHaveLength(1);
      const event = events[0]!;
      expect(event.sessionId).toBe('sess-1');
      expect(event.topic).toBe('quest.completed');
      expect(event.type).toBe('quest.completed');
      expect(event.payload).toEqual({ questId: 'q-1' });
      expect(event.timestamp).toBeDefined();
      expect(event.id).toBe('1');
    });

    it('should support multiple onEmit callbacks', () => {
      const cb1 = vi.fn();
      const cb2 = vi.fn();
      bus.onEmit(cb1);
      bus.onEmit(cb2);

      bus.emit(makeMessage());

      expect(cb1).toHaveBeenCalledTimes(1);
      expect(cb2).toHaveBeenCalledTimes(1);
    });
  });

  describe('onEmit unsubscribe', () => {
    it('should stop callbacks after unsubscribe is called', () => {
      const callback = vi.fn();
      const unsubscribe = bus.onEmit(callback);

      bus.emit(makeMessage());
      expect(callback).toHaveBeenCalledTimes(1);

      unsubscribe();

      bus.emit(makeMessage());
      expect(callback).toHaveBeenCalledTimes(1);
    });
  });

  describe('ring buffer overflow', () => {
    it('should drop oldest events when buffer exceeds 1000 per session', () => {
      // Emit 1050 events
      for (let i = 0; i < 1050; i++) {
        bus.emit(makeMessage({ sessionId: 'sess-1' }));
      }

      // getEventsAfter(0) should return at most 1000 events
      const all = bus.getEventsAfter('sess-1', 0);
      expect(all.length).toBeLessThanOrEqual(1000);

      // The oldest events (seq 1-50) should have been dropped
      // The first available event should be seq 51
      expect(parseInt(all[0]!.id, 10)).toBe(51);
      // The last event should be seq 1050
      expect(parseInt(all[all.length - 1]!.id, 10)).toBe(1050);
    });
  });

  describe('multi-session isolation', () => {
    it('should maintain separate event buffers per session', () => {
      bus.emit(makeMessage({ sessionId: 'sess-1' }));
      bus.emit(makeMessage({ sessionId: 'sess-1' }));
      bus.emit(makeMessage({ sessionId: 'sess-2' }));

      const sess1 = bus.getEventsAfter('sess-1', 0);
      const sess2 = bus.getEventsAfter('sess-2', 0);

      expect(sess1).toHaveLength(2);
      expect(sess2).toHaveLength(1);

      // All sess1 events should have sessionId 'sess-1'
      for (const event of sess1) {
        expect(event.sessionId).toBe('sess-1');
      }
      // All sess2 events should have sessionId 'sess-2'
      for (const event of sess2) {
        expect(event.sessionId).toBe('sess-2');
      }
    });
  });
});
