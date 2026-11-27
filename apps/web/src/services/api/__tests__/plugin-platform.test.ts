import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  fetchPluginInstanceData,
  fetchProviderSources,
  invokePluginAppAction,
  startPluginConfigFlow,
} from "../plugin-platform.js";

const mocks = vi.hoisted(() => ({
  ensureDesktopRestToken: vi.fn(async () => undefined),
  getDesktopRestAuthHeaders: vi.fn(() => ({
    Authorization: "Bearer desktop-secret-token",
  })),
}));

vi.mock("@/lib/desktop-bridge.js", () => ({
  ensureDesktopRestToken: mocks.ensureDesktopRestToken,
  getDesktopRestAuthHeaders: mocks.getDesktopRestAuthHeaders,
}));

describe("plugin-platform API desktop REST auth", () => {
  const fetchMock = vi.fn<typeof fetch>();

  beforeEach(() => {
    vi.stubGlobal("fetch", fetchMock);
    fetchMock.mockImplementation(async () =>
      Response.json({ sources: [], ok: true }),
    );
    mocks.ensureDesktopRestToken.mockClear();
    mocks.getDesktopRestAuthHeaders.mockClear();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("ensures and attaches the desktop REST bearer token on provider sources and instance routes", async () => {
    await fetchProviderSources();
    await fetchPluginInstanceData("openai-codex", "accounts");
    await invokePluginAppAction("openai-codex", "list-accounts", {});
    await startPluginConfigFlow("openai-codex", "oauth-sign-in");

    expect(mocks.ensureDesktopRestToken).toHaveBeenCalledTimes(4);
    expect(fetchMock).toHaveBeenCalledTimes(4);

    for (const call of fetchMock.mock.calls) {
      const headers = new Headers(call[1]?.headers);
      expect(headers.get("Authorization")).toBe("Bearer desktop-secret-token");
    }
    expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/provider-sources");
    expect(fetchMock.mock.calls[1]?.[0]).toBe(
      "/api/plugins/openai-codex/instance-data/accounts",
    );
    expect(fetchMock.mock.calls[2]?.[0]).toBe(
      "/api/plugins/openai-codex/actions/list-accounts",
    );
    expect(fetchMock.mock.calls[3]?.[0]).toBe(
      "/api/plugins/openai-codex/flows/oauth-sign-in/start",
    );
  });
});
