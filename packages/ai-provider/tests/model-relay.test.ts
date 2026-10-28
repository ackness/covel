/**
 * The local model relay: on a shared host, an endpoint on the player's
 * computer or local network goes through the player's browser; every other
 * endpoint keeps the server's network path and its SSRF guard.
 */

import { lookup } from "node:dns/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FormData } from "undici";
import { getJson, postFormData, postJson } from "../src/adapters/http.js";
import { createProviderRegistry } from "../src/provider-registry.js";
import {
  isRelayableBaseUrl,
  type ProviderRelay,
  type ProviderRelayRequest,
} from "../src/adapters/http/model-relay.js";
import {
  configureProviderHostPolicy,
  PERSONAL_PROVIDER_HOST_POLICY,
} from "../src/host-policy.js";

vi.mock("node:dns/promises", () => ({ lookup: vi.fn() }));
const lookupMock = vi.mocked(lookup);

function useSharedHost(): void {
  configureProviderHostPolicy({
    localNetwork: false,
    sessionlessCommunityWires: false,
  });
}

function recordingRelay(response = () => new Response('{"ok":true}')): {
  relay: ProviderRelay;
  requests: ProviderRelayRequest[];
} {
  const requests: ProviderRelayRequest[] = [];
  return {
    requests,
    relay: {
      fetch: async (request) => {
        requests.push(request);
        return response();
      },
    },
  };
}

afterEach(() => {
  lookupMock.mockReset();
  configureProviderHostPolicy(PERSONAL_PROVIDER_HOST_POLICY);
});

describe("isRelayableBaseUrl", () => {
  it.each([
    "http://127.0.0.1:3425/v1",
    "http://localhost:11434",
    "https://[::1]:8443/v1",
    "http://192.168.1.20:8000/v1",
    "http://10.0.0.5/v1",
    "http://172.16.4.2/v1",
    "http://100.101.102.103/v1",
    "http://[fd12:3456::1]/v1",
    "http://gateway.local:1234/v1",
    "https://box.home.arpa/v1",
  ])("relays %s", (url) => {
    expect(isRelayableBaseUrl(url)).toBe(true);
  });

  it.each([
    "https://api.openai.com/v1",
    "http://api.example.com/v1",
    "https://172.32.0.1/v1",
    "https://8.8.8.8/v1",
    "http://user:pw@127.0.0.1/v1",
    "ftp://127.0.0.1/",
    "not a url",
    undefined,
  ])("leaves %s to the server", (url) => {
    expect(isRelayableBaseUrl(url)).toBe(false);
  });
});

describe("relayed provider requests on a shared host", () => {
  it("sends a request for the player's machine through the relay, never the network", async () => {
    useSharedHost();
    const { relay, requests } = recordingRelay();
    const response = await postJson(
      {
        baseUrl: "http://127.0.0.1:3425/v1",
        apiKey: "sk-local",
        relay,
        relayable: true,
      },
      "/chat/completions",
      { model: "m", stream: true },
    );
    expect(await response.json()).toEqual({ ok: true });
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      url: "http://127.0.0.1:3425/v1/chat/completions",
      method: "POST",
      body: '{"model":"m","stream":true}',
    });
    expect(requests[0]?.headers.authorization).toBe("Bearer sk-local");
    expect(lookupMock).not.toHaveBeenCalled();

    await getJson(
      { baseUrl: "http://192.168.1.20:8000/v1", relay, relayable: true },
      "/models",
    );
    expect(requests[1]).toMatchObject({
      url: "http://192.168.1.20:8000/v1/models",
      method: "GET",
    });
    expect(requests[1]?.body).toBeUndefined();
  });

  it("keeps public endpoints on the server's network path", async () => {
    useSharedHost();
    const { relay, requests } = recordingRelay();
    // Plain http to a public name fails the server's string check.
    await expect(
      postJson(
        { baseUrl: "http://api.example.com/v1", relay, relayable: true },
        "/chat/completions",
        {},
        undefined,
        undefined,
        { retry: false },
      ),
    ).rejects.toThrow(/is not allowed/);
    // A public https name goes to DNS, not the browser.
    lookupMock.mockRejectedValue(new Error("lookup refused in test"));
    await expect(
      getJson(
        { baseUrl: "https://api.example.com/v1", relay, relayable: true },
        "/models",
      ),
    ).rejects.toThrow();
    expect(requests).toEqual([]);
  });

  it("is ignored on a personal host, which reaches the address itself", async () => {
    const { relay, requests } = recordingRelay();
    await expect(
      getJson(
        { baseUrl: "http://127.0.0.1:1/v1", relay, relayable: true },
        "/models",
      ),
    ).rejects.toThrow();
    expect(requests).toEqual([]);
  });

  it("refuses file uploads to a relayed endpoint", async () => {
    useSharedHost();
    const { relay, requests } = recordingRelay();
    await expect(
      postFormData(
        { baseUrl: "http://127.0.0.1:3425/v1", relay, relayable: true },
        "/images/edits",
        new FormData(),
      ),
    ).rejects.toThrow(/file uploads cannot go through the local model relay/);
    expect(requests).toEqual([]);
  });

  it("never relays a config that is not marked relayable (server-owned endpoint or key)", async () => {
    useSharedHost();
    const { relay, requests } = recordingRelay();
    await expect(
      postJson(
        { baseUrl: "http://localhost:4000/v1", apiKey: "server-key", relay },
        "/chat/completions",
        {},
      ),
    ).rejects.toThrow(/is not allowed/);
    expect(requests).toEqual([]);
  });

  it("explains a local endpoint that arrives without a relay", async () => {
    useSharedHost();
    await expect(
      postJson(
        { baseUrl: "http://192.168.1.20:8000/v1" },
        "/chat/completions",
        {},
      ),
    ).rejects.toThrow(/no relay was connected for this request/);
  });
});

describe("which provider configs the relay may carry", () => {
  it("marks only endpoints the request chose, without server credentials", () => {
    const registry = createProviderRegistry({
      providerDefaults: {
        litellm: {
          baseUrl: "http://localhost:4000/v1",
          headers: { authorization: "Bearer server-key" },
        },
      },
    });
    // The player's own endpoint for a provider the server knows nothing of.
    expect(
      registry.resolve({
        provider: "my-gateway",
        baseUrl: "http://127.0.0.1:3425/v1",
        requestScoped: true,
      }).config.relayable,
    ).toBe(true);
    // The server's own llm.toml endpoint is never shown to a browser.
    expect(
      registry.resolve({ provider: "litellm" }).config.relayable,
    ).toBeUndefined();
    // The player names the same origin, but the server's key would ride along.
    expect(
      registry.resolve({
        provider: "litellm",
        baseUrl: "http://localhost:4000/v1",
        requestScoped: true,
      }).config.relayable,
    ).toBeUndefined();
  });

  it("drops the mark when a server env key, not the player's, is attached", () => {
    const registry = createProviderRegistry();
    const resolution = registry.resolve({
      provider: "ollama",
      baseUrl: "http://localhost:11434/v1",
      requestScoped: true,
    });
    expect(resolution.config.relayable).toBe(true);
    // Same origin as the built-in default, so the env key would attach.
    const withEnv = registry.withApiKeys(resolution, {}, "ollama", {
      ollama: "server-env-key",
    });
    expect(withEnv.config.apiKey).toBe("server-env-key");
    expect(withEnv.config.relayable).toBeUndefined();
    const withRequest = registry.withApiKeys(
      resolution,
      { ollama: "player-key" },
      "ollama",
      { ollama: "server-env-key" },
    );
    expect(withRequest.config.apiKey).toBe("player-key");
    expect(withRequest.config.relayable).toBe(true);
  });
});
