import { describe, it, expect } from "vitest";
import { bootstrapKernel } from "../src/kernel.js";
import { createPluginHost } from "@covel/plugin-runtime";
import type { PluginManifest } from "@covel/shared";
import type { GatewayLike } from "@covel/runtime";

// ── Test helpers ──────────────────────────────────────────────────

function createStubGateway(): GatewayLike {
  return {
    async generateText() {
      return {
        text: "Stub response.",
        finishReason: "stop",
        usage: { inputTokens: 10, outputTokens: 5 },
      };
    },
    async *streamText() {
      yield {
        type: "done" as const,
        finishReason: "stop",
        usage: { inputTokens: 0, outputTokens: 0 },
      };
    },
  };
}

function makeManifest(id: string): PluginManifest {
  return {
    schemaVersion: "1.0",
    id,
    displayName: id,
    version: "0.1.0",
    author: "test",
    description: `${id} plugin`,
    defaultLocale: "zh-CN",
    supportedLocales: ["zh-CN"],
  };
}

function setupHostWithPlugins(...ids: string[]) {
  const host = createPluginHost();
  for (const id of ids) {
    host.pluginRegistry.add(makeManifest(id), `/tmp/${id}`);
    host.runtimeRegistry.register(id, {
      id: `${id}-runtime`,
      pluginId: id,
      kind: "plugin",
      phase: "post_story",
      trigger: { mode: "always" },
      tools: [],
      hooks: [],
    });
  }
  return host;
}

// ── Session plugin scope via kernel ───────────────────────────────

describe("kernel session plugin scope", () => {
  it("createSession with activePlugins creates a scoped session", () => {
    const host = setupHostWithPlugins("alpha", "beta", "gamma");
    const instance = bootstrapKernel({ pluginHost: host, gateway: createStubGateway() });

    const session = instance.createSession({ activePlugins: ["alpha", "gamma"] });

    expect(session.listActivePlugins()).toHaveLength(2);
    expect(session.listActivePlugins()).toContain("alpha");
    expect(session.listActivePlugins()).toContain("gamma");
    expect(session.listActivePlugins()).not.toContain("beta");
  });

  it("listActivePlugins returns the correct subset", () => {
    const host = setupHostWithPlugins("a", "b", "c");
    const instance = bootstrapKernel({ pluginHost: host, gateway: createStubGateway() });

    const session = instance.createSession({ activePlugins: ["b"] });

    const active = session.listActivePlugins();
    expect(active).toHaveLength(1);
    expect(active).toContain("b");
  });

  it("enablePlugin adds a plugin to the active set", () => {
    const host = setupHostWithPlugins("alpha", "beta");
    const instance = bootstrapKernel({ pluginHost: host, gateway: createStubGateway() });

    const session = instance.createSession({ activePlugins: ["alpha"] });
    expect(session.listActivePlugins()).not.toContain("beta");

    session.enablePlugin("beta");
    expect(session.listActivePlugins()).toContain("beta");
  });

  it("disablePlugin removes a plugin from the active set", () => {
    const host = setupHostWithPlugins("alpha", "beta");
    const instance = bootstrapKernel({ pluginHost: host, gateway: createStubGateway() });

    const session = instance.createSession();
    expect(session.listActivePlugins()).toContain("alpha");

    session.disablePlugin("alpha");
    expect(session.listActivePlugins()).not.toContain("alpha");
  });

  it("enablePlugin throws for non-existent plugin", () => {
    const host = setupHostWithPlugins("alpha");
    const instance = bootstrapKernel({ pluginHost: host, gateway: createStubGateway() });

    const session = instance.createSession();

    expect(() => session.enablePlugin("ghost")).toThrow(
      /Cannot enable plugin "ghost"/
    );
  });

  it("listAvailablePlugins returns all loaded plugins", () => {
    const host = setupHostWithPlugins("alpha", "beta", "gamma");
    const instance = bootstrapKernel({ pluginHost: host, gateway: createStubGateway() });

    const session = instance.createSession({ activePlugins: ["alpha"] });

    const available = session.listAvailablePlugins();
    expect(available).toHaveLength(3);
    expect(available).toContain("alpha");
    expect(available).toContain("beta");
    expect(available).toContain("gamma");
  });

  it("exposes pluginScope on the session", () => {
    const host = setupHostWithPlugins("alpha");
    const instance = bootstrapKernel({ pluginHost: host, gateway: createStubGateway() });

    const session = instance.createSession();

    expect(session.pluginScope).toBeDefined();
    expect(session.pluginScope.isActive("alpha")).toBe(true);
  });
});

// ── Backward compatibility ────────────────────────────────────────

describe("kernel session backward compatibility", () => {
  it("createSession() with no options activates all plugins", () => {
    const host = setupHostWithPlugins("alpha", "beta");
    const instance = bootstrapKernel({ pluginHost: host, gateway: createStubGateway() });

    const session = instance.createSession();

    expect(session.listActivePlugins()).toHaveLength(2);
    expect(session.listActivePlugins()).toContain("alpha");
    expect(session.listActivePlugins()).toContain("beta");
  });

  it("createSession(context) with plain object activates all plugins", () => {
    const host = setupHostWithPlugins("alpha", "beta");
    const instance = bootstrapKernel({ pluginHost: host, gateway: createStubGateway() });

    // Pass a plain KernelContext object (backward-compat path)
    const session = instance.createSession({ state: { hp: 100 } });

    expect(session.listActivePlugins()).toHaveLength(2);
    expect(session.getContext().state).toEqual({ hp: 100 });
  });

  it("createSession with initialContext in options form works", () => {
    const host = setupHostWithPlugins("alpha");
    const instance = bootstrapKernel({ pluginHost: host, gateway: createStubGateway() });

    const session = instance.createSession({
      initialContext: { state: { gold: 50 } },
      activePlugins: ["alpha"],
    });

    expect(session.listActivePlugins()).toHaveLength(1);
    expect(session.getContext().state).toEqual({ gold: 50 });
  });

  it("sessions are isolated from each other", () => {
    const host = setupHostWithPlugins("alpha", "beta");
    const instance = bootstrapKernel({ pluginHost: host, gateway: createStubGateway() });

    const session1 = instance.createSession({ activePlugins: ["alpha"] });
    const session2 = instance.createSession({ activePlugins: ["beta"] });

    expect(session1.listActivePlugins()).toContain("alpha");
    expect(session1.listActivePlugins()).not.toContain("beta");

    expect(session2.listActivePlugins()).toContain("beta");
    expect(session2.listActivePlugins()).not.toContain("alpha");

    // Enabling in one session does not affect the other
    session1.enablePlugin("beta");
    expect(session1.listActivePlugins()).toContain("beta");
    expect(session2.listActivePlugins()).not.toContain("alpha");
  });
});
