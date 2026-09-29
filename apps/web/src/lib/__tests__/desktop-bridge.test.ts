import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  openConfigDir,
  openKeysEnv,
  openLlmToml,
  pickDataDir,
  probeDesktopMode,
} from "../desktop-bridge.js";

const originalIpc = window.covelIpc;
const originalFetch = globalThis.fetch;

type FetchCall = Parameters<typeof fetch>;

function mockFetch(response: Response): ReturnType<typeof vi.fn> {
  const fn = vi.fn(async (..._args: FetchCall) => response);
  globalThis.fetch = fn as unknown as typeof fetch;
  return fn;
}

beforeEach(() => {
  delete window.covelIpc;
});

afterEach(() => {
  vi.restoreAllMocks();
  if (originalIpc === undefined) {
    delete window.covelIpc;
  } else {
    window.covelIpc = originalIpc;
  }
  globalThis.fetch = originalFetch;
});

describe("desktop bridge REST helpers", () => {
  it("retries an inconclusive probe before accepting a desktop response", async () => {
    vi.resetModules();
    const bridge = await import("../desktop-bridge.js");
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new Error("temporarily offline"))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ isDesktop: true }), { status: 200 }),
      );
    globalThis.fetch = fetchMock as typeof fetch;

    await expect(bridge.probeDesktopMode()).resolves.toBe("unknown");
    expect(bridge.isDesktopApp()).toBe(false);
    await expect(bridge.probeDesktopMode()).resolves.toBe("desktop");
    expect(bridge.isDesktopApp()).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("accepts an explicit pure web response but not an incomplete one", async () => {
    vi.resetModules();
    const bridge = await import("../desktop-bridge.js");
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response("{}", { status: 200 }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ isDesktop: false }), { status: 200 }),
      );
    globalThis.fetch = fetchMock as typeof fetch;

    await expect(bridge.probeDesktopMode()).resolves.toBe("unknown");
    await expect(bridge.probeDesktopMode()).resolves.toBe("web");
    await expect(bridge.probeDesktopMode()).resolves.toBe("web");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(bridge.isDesktopApp()).toBe(false);
  });

  it("posts open file requests through the desktop config REST endpoint", async () => {
    const fetchMock = mockFetch(new Response("{}", { status: 200 }));

    await openLlmToml();
    await openKeysEnv();

    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      "/api/config/open-folder",
      expect.objectContaining({
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ target: "llm.toml" }),
      }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "/api/config/open-folder",
      expect.objectContaining({
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ target: "keys.env" }),
      }),
    );
  });

  it("updates data root through the desktop config REST endpoint", async () => {
    const fetchMock = mockFetch(new Response("{}", { status: 200 }));

    await expect(pickDataDir("/tmp/covel-data")).resolves.toBe(
      "/tmp/covel-data",
    );

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/config/data-root",
      expect.objectContaining({
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: "/tmp/covel-data" }),
      }),
    );
  });

  it("adds the desktop REST token after probing IPC info", async () => {
    const invoke = vi.fn(async () => ({ restToken: "secret-token" }));
    window.covelIpc = {
      isDesktop: true,
      platform: "darwin",
      appVersion: "test",
      send: vi.fn(() => true),
      invoke: invoke as unknown as NonNullable<
        typeof window.covelIpc
      >["invoke"],
      on: vi.fn(() => () => {}),
    };
    const fetchMock = mockFetch(new Response("{}", { status: 200 }));

    await expect(probeDesktopMode()).resolves.toBe("desktop");
    await openLlmToml();

    expect(invoke).toHaveBeenCalledWith("covel:get-info");
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/config/open-folder",
      expect.objectContaining({
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer secret-token",
        },
      }),
    );
  });

  it("throws JSON error messages and falls back to HTTP status", async () => {
    mockFetch(
      new Response(JSON.stringify({ error: "cannot open file" }), {
        status: 500,
        headers: { "Content-Type": "application/json" },
      }),
    );
    await expect(openLlmToml()).rejects.toThrow("cannot open file");

    mockFetch(new Response("plain failure", { status: 418, statusText: "" }));
    await expect(openKeysEnv()).rejects.toThrow("HTTP 418");
  });

  it("prefers Electron IPC over REST fetches", async () => {
    const invoke = vi.fn(async () => ({ path: "/ipc-data" }));
    window.covelIpc = {
      isDesktop: true,
      platform: "darwin",
      appVersion: "test",
      send: vi.fn(() => true),
      invoke: invoke as unknown as NonNullable<
        typeof window.covelIpc
      >["invoke"],
      on: vi.fn(() => () => {}),
    };
    const fetchMock = mockFetch(new Response("{}", { status: 200 }));

    await openConfigDir();
    await expect(pickDataDir()).resolves.toBe("/ipc-data");

    expect(invoke).toHaveBeenCalledWith("covel:open-config-dir");
    expect(invoke).toHaveBeenCalledWith("covel:pick-data-dir");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
