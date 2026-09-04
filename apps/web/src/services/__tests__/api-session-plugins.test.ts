import { afterEach, describe, expect, it, vi } from "vitest";
import type { PluginSummary, SessionPlugin } from "@covel/shared";

const localStorageMock = (() => {
  let store: Record<string, string> = {};
  return {
    getItem: vi.fn((key: string) => store[key] ?? null),
    setItem: vi.fn((key: string, value: string) => {
      store[key] = value;
    }),
    removeItem: vi.fn((key: string) => {
      delete store[key];
    }),
    clear: vi.fn(() => {
      store = {};
    }),
  };
})();

Object.defineProperty(globalThis, "localStorage", {
  value: localStorageMock,
  writable: false,
});

const {
  disableSessionPlugin,
  enableSessionPlugin,
  fetchPluginFlows,
  getPluginCatalog,
  listPlugins,
  listSessionPlugins,
} = await import("../api.js");

function mockFetchOnce(body: unknown, status = 200): void {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValueOnce({
      ok: status >= 200 && status < 300,
      status,
      json: () => Promise.resolve(body),
      text: () => Promise.resolve(JSON.stringify(body)),
    }),
  );
}

function plugin(overrides: Partial<PluginSummary> = {}): PluginSummary {
  return {
    id: "memory",
    displayName: "Memory",
    description: "Memory plugin",
    pluginType: "plugin",
    source: "builtin",
    status: "registered",
    runtimeCount: 1,
    capabilities: ["memory-panel"],
    tags: [],
    runtimes: [
      {
        id: "memory",
        runtimeType: "agent",
        trigger: { type: "auto" },
        execution: "sync",
        turnCompletion: { mode: "await" },
        outputKind: "plugin",
        capabilities: ["memory-panel"],
        tags: [],
      },
    ],
    tools: [],
    userSettings: [],
    ...overrides,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  localStorageMock.clear();
});

describe("session plugin API", () => {
  it("returns the canonical list envelope without client-side remapping", async () => {
    const item: SessionPlugin = {
      ...plugin(),
      active: true,
      locked: false,
    };
    mockFetchOnce({ items: [item], commands: [] });

    await expect(listSessionPlugins("session/1")).resolves.toEqual({
      items: [item],
      commands: [],
    });
    expect(vi.mocked(fetch).mock.calls[0]?.[0]).toBe(
      "/api/sessions/session%2F1/plugins",
    );
  });

  it("enables with PUT on the plugin resource", async () => {
    const response = { ok: true, activePluginIds: ["memory"] };
    mockFetchOnce(response);
    await expect(enableSessionPlugin("session 1", "memory/x")).resolves.toEqual(
      response,
    );
    const [url, init] = vi.mocked(fetch).mock.calls[0]!;
    expect(url).toBe("/api/sessions/session%201/plugins/memory%2Fx");
    expect(init?.method).toBe("PUT");
    expect(init?.body).toBeUndefined();
  });

  it("disables with DELETE on the same plugin resource", async () => {
    mockFetchOnce({ ok: true, activePluginIds: [] });
    await disableSessionPlugin("session-1", "memory");
    const [url, init] = vi.mocked(fetch).mock.calls[0]!;
    expect(url).toBe("/api/sessions/session-1/plugins/memory");
    expect(init?.method).toBe("DELETE");
  });
});

describe("plugin discovery API", () => {
  it("uses one canonical plugin descriptor and exposes load failures separately", async () => {
    mockFetchOnce({
      items: [
        plugin(),
        plugin({ id: "broken", status: "error", error: "bad manifest" }),
      ],
    });

    await expect(getPluginCatalog()).resolves.toEqual({
      items: [plugin()],
      loadErrors: [{ pluginId: "broken", errors: ["bad manifest"] }],
    });
    expect(vi.mocked(fetch).mock.calls[0]?.[0]).toBe("/api/plugins");

    mockFetchOnce({ items: [plugin()] });
    await expect(listPlugins()).resolves.toEqual([plugin()]);
  });

  it("normalizes only flow-specific optional turn completion", async () => {
    mockFetchOnce({
      segments: [{ id: "event-manual", label: "Manual" }],
      steps: [
        {
          pluginId: "memory",
          runtimeId: "memory/manual",
          segmentId: "event-manual",
          trigger: { type: "manual" },
        },
      ],
    });
    const flow = await fetchPluginFlows();
    expect(flow.steps[0]?.turnCompletion).toEqual({ mode: "await" });
  });
});
