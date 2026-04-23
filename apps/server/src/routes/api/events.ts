/**
 * API Event routes — SSE subscribe and emit.
 *
 * GET  /subscribe?sessionId=xxx — SSE stream of real-time events for a session
 * POST /emit                    — External event injection into the EventBus
 */

import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import type { EventBus } from '@covel/events';
import type { DataStore } from '@covel/store';
import type { CovelMessage } from '@covel/shared';
import { isEnvTruthy, readRuntimeEnv } from '@covel/shared';

type Env = {
  Variables: {
    eventBus: EventBus;
    store: DataStore;
  };
};

export const eventRoutes = new Hono<Env>();

// GET /events/subscribe?sessionId=xxx — SSE event stream
eventRoutes.get('/subscribe', async (c) => {
  const eventBus = c.get('eventBus');
  const sessionId = c.req.query('sessionId');

  if (!sessionId) {
    return c.json({ error: 'sessionId query parameter required' }, 400);
  }

  return streamSSE(c, async (stream) => {
    // Send connection confirmation
    await stream.writeSSE({
      event: 'connected',
      data: JSON.stringify({ sessionId, timestamp: new Date().toISOString() }),
    });

    // Subscribe to all events, filter by sessionId
    const unsubscribe = eventBus.on('*', async (message) => {
      if (message.sessionId === sessionId) {
        await stream.writeSSE({
          event: message.topic,
          data: JSON.stringify(message.payload),
          id: message.id,
        });
      }
    });

    // Keep connection alive until client disconnects
    try {
      while (true) {
        await stream.sleep(30_000);
      }
    } catch {
      // Client disconnected — clean up
    } finally {
      unsubscribe();
    }
  });
});

// POST /events/emit — External event injection (debug/dev only)
eventRoutes.post('/emit', async (c) => {
  // Gate behind ENABLE_DEBUG_PAGE or non-production to prevent arbitrary event injection
  const debugEnabled = isEnvTruthy('ENABLE_DEBUG_PAGE');
  const isProduction = readRuntimeEnv().nodeEnv === 'production';
  if (isProduction && !debugEnabled) {
    return c.json({ error: 'Event injection is disabled in production' }, 403);
  }

  const eventBus = c.get('eventBus');
  const body = await c.req.json<{
    topic?: string;
    payload?: Record<string, unknown>;
    sessionId?: string;
    targetRuntime?: string;
  }>();

  if (!body.topic || !body.sessionId) {
    return c.json({ error: 'topic and sessionId are required' }, 400);
  }

  const message: CovelMessage = {
    id: crypto.randomUUID(),
    type: 'event',
    topic: body.topic,
    payload: body.payload ?? {},
    sessionId: body.sessionId,
    targetRuntime: body.targetRuntime,
    timestamp: new Date().toISOString(),
  };

  eventBus.emit(message);
  return c.json({ id: message.id, emitted: true });
});
