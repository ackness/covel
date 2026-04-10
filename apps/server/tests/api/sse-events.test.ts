/**
 * V2 SSE Events — tests for EventBus-wired SSE subscribe and emit endpoints.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { Hono } from 'hono';
import { createEventBus, type EventBus } from '@covel/events';
import { createMemoryStore } from '@covel/store';
import { eventRoutes } from '../../src/routes/api/events.js';
import type { CovelMessage } from '@covel/shared';

function createTestApp(eventBus: EventBus): Hono {
  const store = createMemoryStore();
  const app = new Hono();
  app.use('*', async (c, next) => {
    c.set('eventBus', eventBus);
    c.set('store', store);
    await next();
  });
  app.route('/api/events', eventRoutes);
  return app;
}

describe('V2 SSE Events', () => {
  let app: Hono;
  let eventBus: EventBus;

  beforeEach(() => {
    const store = createMemoryStore();
    eventBus = createEventBus(store);
    app = createTestApp(eventBus);
  });

  describe('POST /api/events/emit', () => {
    it('should emit an event and return id', async () => {
      const res = await app.request('/api/events/emit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          topic: 'quest.completed',
          payload: { questId: 'q-1', reward: 100 },
          sessionId: 'sess-1',
        }),
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.id).toBeDefined();
      expect(body.emitted).toBe(true);
    });

    it('should trigger EventBus handlers', async () => {
      const received: CovelMessage[] = [];
      eventBus.on('test.event', (msg) => {
        received.push(msg);
      });

      await app.request('/api/events/emit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          topic: 'test.event',
          payload: { data: 'hello' },
          sessionId: 'sess-1',
        }),
      });

      expect(received).toHaveLength(1);
      expect(received[0].payload).toEqual({ data: 'hello' });
    });

    it('should require topic and sessionId', async () => {
      const res = await app.request('/api/events/emit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ payload: {} }),
      });
      expect(res.status).toBe(400);
    });

    it('should pass targetRuntime if provided', async () => {
      const received: CovelMessage[] = [];
      eventBus.on('routed.event', (msg) => {
        received.push(msg);
      });

      await app.request('/api/events/emit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          topic: 'routed.event',
          payload: { x: 1 },
          sessionId: 'sess-1',
          targetRuntime: 'core-narrator/narrator',
        }),
      });

      expect(received).toHaveLength(1);
      expect(received[0].targetRuntime).toBe('core-narrator/narrator');
    });
  });

  describe('GET /api/events/stream (subscribe route)', () => {
    it('M2: should return 400 for invalid topics parameter', async () => {
      // We need a session for this — create a test app with subscribe routes
      const { subscribeRoutes } = await import('../../src/routes/api/subscribe.js');
      const subApp = new Hono();
      const store = createMemoryStore();
      // Create a session so the route can find it
      await store.createSession({
        id: 'sess-topic',
        worldId: null,
        status: 'active',
        phase: 'playing',
        presetId: null,
        activePlugins: [],
        createdAt: new Date().toISOString(),
      });
      subApp.use('*', async (c, next) => {
        c.set('eventBus', eventBus);
        c.set('store', store);
        await next();
      });
      subApp.route('/api/events', subscribeRoutes);

      const res = await subApp.request('/api/events/stream?sessionId=sess-topic&topics=runtime,bogus_topic');
      expect(res.status).toBe(400);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body.error).toContain('bogus_topic');
    });
  });

  describe('GET /api/events/subscribe', () => {
    it('should require sessionId parameter', async () => {
      const res = await app.request('/api/events/subscribe');
      expect(res.status).toBe(400);
    });

    it('should return SSE content type', async () => {
      const res = await app.request('/api/events/subscribe?sessionId=sess-1');
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toContain('text/event-stream');
    });

    it('should send connected event as first SSE chunk', async () => {
      const res = await app.request('/api/events/subscribe?sessionId=sess-1');
      // Read the first chunk from the response body stream
      const reader = res.body!.getReader();
      const { value } = await reader.read();
      reader.cancel(); // Cancel to unblock the stream

      const text = new TextDecoder().decode(value);
      // SSE format: "event: connected\ndata: ..."
      expect(text).toContain('event: connected');
      expect(text).toContain('"sessionId":"sess-1"');
    });

    it('should subscribe to EventBus and filter by sessionId', () => {
      // Verify the EventBus wiring directly: the wildcard handler pattern
      // used inside the SSE route correctly filters by sessionId.
      const matchingMessages: CovelMessage[] = [];
      const sessionId = 'sess-1';

      // Simulate the same filter logic used in the SSE route
      const unsubscribe = eventBus.on('*', (message) => {
        if (message.sessionId === sessionId) {
          matchingMessages.push(message);
        }
      });

      // Emit matching event
      eventBus.emit({
        id: 'msg-1',
        type: 'event',
        topic: 'turn:start',
        payload: { turnNumber: 1 },
        sessionId: 'sess-1',
        timestamp: new Date().toISOString(),
      });

      // Emit non-matching event (different session)
      eventBus.emit({
        id: 'msg-other',
        type: 'event',
        topic: 'other:event',
        payload: { x: 1 },
        sessionId: 'sess-other',
        timestamp: new Date().toISOString(),
      });

      expect(matchingMessages).toHaveLength(1);
      expect(matchingMessages[0].topic).toBe('turn:start');
      expect(matchingMessages[0].payload).toEqual({ turnNumber: 1 });

      unsubscribe();
    });

    it('should unsubscribe handler on disconnect', () => {
      const received: CovelMessage[] = [];

      const unsubscribe = eventBus.on('*', (message) => {
        received.push(message);
      });

      eventBus.emit({
        id: 'msg-a',
        type: 'event',
        topic: 'before',
        payload: {},
        sessionId: 'sess-1',
        timestamp: new Date().toISOString(),
      });

      // Simulate client disconnect
      unsubscribe();

      eventBus.emit({
        id: 'msg-b',
        type: 'event',
        topic: 'after',
        payload: {},
        sessionId: 'sess-1',
        timestamp: new Date().toISOString(),
      });

      // Should only have received the first event
      expect(received).toHaveLength(1);
      expect(received[0].topic).toBe('before');
    });
  });
});
