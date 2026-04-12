/**
 * session-store SSE wiring smoke test.
 *
 * Asserts that resumeSession() opens an EventSource on /api/events/stream
 * and backToWorldSelect() closes it. Stubs EventSource / fetch / localStorage
 * directly on globalThis to avoid pulling in jsdom.
 *
 * Followup A for 2026-04-12 audit Finding w1.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// ── Stubs ────────────────────────────────────────────────────────

class MockEventSource {
  static instances: MockEventSource[] = [];
  static lastUrl: string | null = null;

  url: string;
  closed = false;
  onmessage: ((e: MessageEvent) => void) | null = null;
  onerror: (() => void) | null = null;
  private listeners = new Map<string, (e: MessageEvent) => void>();

  constructor(url: string) {
    this.url = url;
    MockEventSource.lastUrl = url;
    MockEventSource.instances.push(this);
  }

  addEventListener(type: string, handler: (e: MessageEvent) => void): void {
    this.listeners.set(type, handler);
  }

  removeEventListener(type: string): void {
    this.listeners.delete(type);
  }

  /** Test helper: simulate the server pushing an SSE event. Returns true if a handler was registered. */
  fire(type: string, data: unknown): boolean {
    const handler = this.listeners.get(type);
    if (!handler) return false;
    handler(new MessageEvent(type, { data: JSON.stringify(data) }));
    return true;
  }

  hasListener(type: string): boolean {
    return this.listeners.has(type);
  }

  close(): void {
    this.closed = true;
  }

  static reset(): void {
    MockEventSource.instances = [];
    MockEventSource.lastUrl = null;
  }
}

class MockLocalStorage {
  private store = new Map<string, string>();
  getItem(key: string): string | null { return this.store.get(key) ?? null; }
  setItem(key: string, value: string): void { this.store.set(key, value); }
  removeItem(key: string): void { this.store.delete(key); }
  clear(): void { this.store.clear(); }
  get length(): number { return this.store.size; }
  key(_index: number): string | null { return null; }
}

// Minimal fetch stub returning canned snapshot/plugin-data shapes.
function makeFetchStub() {
  return vi.fn(async (input: RequestInfo | URL): Promise<Response> => {
    const url = typeof input === "string" ? input : input.toString();

    if (url.startsWith("/api/sessions/") && url.endsWith("/snapshot")) {
      return jsonResponse({
        session: { id: "sess-1", worldId: "w1", phase: "playing", turnCount: 0, locale: "zh-CN" },
        messages: [],
        characters: [],
        gameState: {},
        executionSteps: [],
        plugins: [],
      });
    }

    if (url.startsWith("/api/sessions/") && url.includes("/plugin-data/")) {
      return jsonResponse({ items: [] });
    }

    return jsonResponse({ items: [] });
  });
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

// ── Setup / teardown ─────────────────────────────────────────────

type GlobalLike = Record<string, unknown>;

beforeEach(() => {
  vi.resetModules();
  MockEventSource.reset();
  (globalThis as GlobalLike).EventSource = MockEventSource;
  (globalThis as GlobalLike).localStorage = new MockLocalStorage();
  (globalThis as GlobalLike).fetch = makeFetchStub();
});

afterEach(() => {
  delete (globalThis as GlobalLike).EventSource;
  delete (globalThis as GlobalLike).localStorage;
  delete (globalThis as GlobalLike).fetch;
});

// ── Tests ────────────────────────────────────────────────────────

describe("session-store SSE wiring", () => {
  it("opens an EventSource pointed at /api/events/stream when resumeSession runs", async () => {
    const { resumeSession } = await import("../session-store.js");
    await resumeSession("sess-1", "w1");

    expect(MockEventSource.instances).toHaveLength(1);
    expect(MockEventSource.lastUrl).not.toBeNull();
    expect(MockEventSource.lastUrl).toContain("/api/events/stream");
    expect(MockEventSource.lastUrl).toContain("sessionId=sess-1");
  });

  it("closes the EventSource when backToWorldSelect runs", async () => {
    const { resumeSession, backToWorldSelect } = await import("../session-store.js");
    await resumeSession("sess-1", "w1");
    expect(MockEventSource.instances).toHaveLength(1);
    expect(MockEventSource.instances[0].closed).toBe(false);

    backToWorldSelect();
    expect(MockEventSource.instances[0].closed).toBe(true);
  });

  it("opens a fresh EventSource and closes the old one on session switch", async () => {
    const { resumeSession } = await import("../session-store.js");
    await resumeSession("sess-1", "w1");
    const first = MockEventSource.instances[0];

    await resumeSession("sess-2", "w1");
    // Old one closed, new one open
    expect(first.closed).toBe(true);
    expect(MockEventSource.instances).toHaveLength(2);
    expect(MockEventSource.instances[1].closed).toBe(false);
    expect(MockEventSource.instances[1].url).toContain("sessionId=sess-2");
  });

  // Followup D regression — the connectSSE helper must register a listener
  // for the `phase.changed` SSE event. Before this, only `plugin-data.changed`
  // had a dedicated listener and phase transitions never reached the frontend
  // reducer (the unnamed-event onmessage path doesn't fire for named events).
  it("registers a phase.changed listener that fires when the server emits", async () => {
    const { resumeSession } = await import("../session-store.js");
    await resumeSession("sess-1", "w1");

    const es = MockEventSource.instances[0];
    expect(es.hasListener("phase.changed")).toBe(true);
    expect(es.hasListener("plugin-data.changed")).toBe(true);

    // Firing the event should hit the registered handler (returns true).
    const handled = es.fire("phase.changed", {
      id: "1",
      topic: "session",
      type: "phase.changed",
      sessionId: "sess-1",
      timestamp: new Date().toISOString(),
      payload: { phase: "ended" },
    });
    expect(handled).toBe(true);
  });
});
