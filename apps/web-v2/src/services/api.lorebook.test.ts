/**
 * Lorebook API client smoke tests (S3-T6).
 *
 * Verifies the fetch wrappers hit the expected endpoints and shape the
 * server response correctly. Component-level tests live under
 * `components/panels/` once a jsdom setup exists — for now the panel is
 * kept thin enough that exercising the client layer is sufficient.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

type GlobalLike = Record<string, unknown>;

type FetchCall = {
  url: string;
  init?: RequestInit;
};

function makeFetchStub(handler: (url: string, init?: RequestInit) => Response) {
  const calls: FetchCall[] = [];
  const stub = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    calls.push({ url, init });
    return handler(url, init);
  });
  return { stub, calls };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

beforeEach(() => {
  vi.resetModules();
});

afterEach(() => {
  delete (globalThis as GlobalLike).fetch;
});

describe("lorebook API client", () => {
  it("fetchLorebookEntries returns entries array from the envelope", async () => {
    const sampleEntry = {
      id: "e1",
      sessionId: "sess-1",
      pluginId: "test-plugin",
      keys: [],
      content: "hello",
      strategy: "constant",
      position: "before-memory",
      insertionOrder: 100,
      enabled: true,
      createdAt: "2026-04-13T00:00:00.000Z",
      updatedAt: "2026-04-13T00:00:00.000Z",
    };
    const { stub, calls } = makeFetchStub(() =>
      jsonResponse({ entries: [sampleEntry] }),
    );
    (globalThis as GlobalLike).fetch = stub;

    const { fetchLorebookEntries } = await import("./api.js");
    const entries = await fetchLorebookEntries("sess-1");
    expect(entries).toHaveLength(1);
    expect(entries[0].id).toBe("e1");
    expect(calls[0].url).toBe("/api/sessions/sess-1/lorebook");
  });

  it("fetchLorebookEntries returns an empty array when the server omits the field", async () => {
    const { stub } = makeFetchStub(() => jsonResponse({}));
    (globalThis as GlobalLike).fetch = stub;

    const { fetchLorebookEntries } = await import("./api.js");
    const entries = await fetchLorebookEntries("sess-1");
    expect(entries).toEqual([]);
  });

  it("updateLorebookEntryEnabled sends PATCH with enabled flag", async () => {
    const { stub, calls } = makeFetchStub(() =>
      jsonResponse({ success: true, entryId: "e1", enabled: false }),
    );
    (globalThis as GlobalLike).fetch = stub;

    const { updateLorebookEntryEnabled } = await import("./api.js");
    await updateLorebookEntryEnabled("sess-1", "e1", false);

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("/api/sessions/sess-1/lorebook/e1");
    expect(calls[0].init?.method).toBe("PATCH");
    const body = JSON.parse(String(calls[0].init?.body ?? "{}"));
    expect(body).toEqual({ enabled: false });
  });

  it("deleteLorebookEntry sends DELETE to the entry path", async () => {
    const { stub, calls } = makeFetchStub(() => jsonResponse({ success: true }));
    (globalThis as GlobalLike).fetch = stub;

    const { deleteLorebookEntry } = await import("./api.js");
    await deleteLorebookEntry("sess-1", "e1");

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("/api/sessions/sess-1/lorebook/e1");
    expect(calls[0].init?.method).toBe("DELETE");
  });

  it("throws a descriptive error when the server returns non-OK", async () => {
    const { stub } = makeFetchStub(() =>
      new Response("entry missing", { status: 404 }),
    );
    (globalThis as GlobalLike).fetch = stub;

    const { fetchLorebookEntries } = await import("./api.js");
    await expect(fetchLorebookEntries("sess-1")).rejects.toThrow(/404/);
  });
});
