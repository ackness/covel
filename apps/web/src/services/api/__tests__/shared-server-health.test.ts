import { afterEach, describe, expect, it, vi } from "vitest";

const transport = vi.hoisted(() => ({ body: {} as unknown }));

vi.mock("../request.js", () => ({
  ApiError: class ApiError extends Error {
    status = 500;
  },
  requestResponse: async () =>
    new Response(JSON.stringify(transport.body), {
      headers: { "Content-Type": "application/json" },
    }),
}));

const {
  fetchServerHealth,
  getDeploymentCapabilityCeiling,
  getSharedServerInfo,
  isDeploymentCapabilityDisabled,
} = await import("../health.js");

function health(
  form: string,
  frontendMode: string,
  source?: Record<string, unknown>,
) {
  return {
    status: "ok",
    deployment: { form, ...(source ? { source } : {}) },
    storage: { data: { frontendMode } },
  };
}

afterEach(() => {
  transport.body = {};
});

describe("getSharedServerInfo", () => {
  it("describes a browser-private server and its build's source", async () => {
    transport.body = health("browser-private", "local", {
      repository: "https://github.com/ackness/covel",
      commit: "c1e2867d9",
    });
    await fetchServerHealth();
    expect(getSharedServerInfo()).toEqual({
      repository: "https://github.com/ackness/covel",
      commit: "c1e2867d9",
    });
  });

  it("is null on a personal server and where saves stay on the server", async () => {
    transport.body = health("personal", "local");
    await fetchServerHealth();
    expect(getSharedServerInfo()).toBeNull();

    transport.body = health("hosted", "remote");
    await fetchServerHealth();
    expect(getSharedServerInfo()).toBeNull();

    transport.body = health("hosted", "local");
    await fetchServerHealth();
    expect(getSharedServerInfo()).toEqual({});
  });

  it("drops a source that is not an https address or a hex commit", async () => {
    transport.body = health("browser-private", "local", {
      repository: "javascript:alert(1)",
      commit: "<img>",
    });
    await fetchServerHealth();
    expect(getSharedServerInfo()).toEqual({});

    transport.body = health("browser-private", "local", {
      repository: "https://user:pw@example.com/repo",
    });
    await fetchServerHealth();
    expect(getSharedServerInfo()).toEqual({});
  });

  it("parses valid deployment capability ceilings and drops malformed entries", async () => {
    transport.body = {
      status: "ok",
      deployment: {
        form: "browser-private",
        capabilities: {
          "plugin.providerSource": "disabled",
          "plugin.communityCode": "operator-only",
          "plugin.declarative": "enabled",
          "unknown.key": "enabled",
          "secrets.own": "super-admin",
        },
      },
    };
    await fetchServerHealth();
    expect(getDeploymentCapabilityCeiling("plugin.providerSource")).toBe(
      "disabled",
    );
    expect(isDeploymentCapabilityDisabled("plugin.providerSource")).toBe(true);
    expect(getDeploymentCapabilityCeiling("plugin.communityCode")).toBe(
      "operator-only",
    );
    expect(isDeploymentCapabilityDisabled("plugin.communityCode")).toBe(false);
    expect(getDeploymentCapabilityCeiling("plugin.declarative")).toBe(
      "enabled",
    );
    expect(getDeploymentCapabilityCeiling("secrets.own")).toBeUndefined();
    expect(isDeploymentCapabilityDisabled("secrets.own")).toBe(false);

    // Resets when a subsequent health response omits capabilities.
    transport.body = health("personal", "remote");
    await fetchServerHealth();
    expect(
      getDeploymentCapabilityCeiling("plugin.providerSource"),
    ).toBeUndefined();
    expect(isDeploymentCapabilityDisabled("plugin.providerSource")).toBe(false);
  });
});
