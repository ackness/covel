import { describe, it, expect } from "vitest";
import { createPluginRegistry } from "../src/registry/plugin-registry.js";
import { createRuntimeRegistry } from "../src/registry/runtime-registry.js";
import { createToolRegistry } from "../src/registry/tool-registry.js";
import { createHookRegistry } from "../src/registry/hook-registry.js";
import {
  createSessionPluginScope,
  createScopedRuntimeRegistry,
  createScopedToolRegistry,
  createScopedHookRegistry,
  createScopedContextProviders,
} from "../src/scope/session-plugin-scope.js";
import type { RegisteredContextProvider } from "../src/types.js";
import type { PluginManifest } from "@covel/shared";

// ── Test helpers ──────────────────────────────────────────────────

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

function setupPluginRegistry(...ids: string[]) {
  const registry = createPluginRegistry();
  for (const id of ids) {
    registry.add(makeManifest(id), `/tmp/${id}`);
  }
  return registry;
}

const stubHandler = async () => ({ allow: true });
const stubToolHandler = async () => ({ result: "ok" as unknown });

// ── createSessionPluginScope ──────────────────────────────────────

describe("createSessionPluginScope", () => {
  it("activates all enabled plugins by default", () => {
    const pluginReg = setupPluginRegistry("alpha", "beta", "gamma");
    const scope = createSessionPluginScope(pluginReg);

    expect(scope.listActive()).toHaveLength(3);
    expect(scope.isActive("alpha")).toBe(true);
    expect(scope.isActive("beta")).toBe(true);
    expect(scope.isActive("gamma")).toBe(true);
  });

  it("activates only the specified subset", () => {
    const pluginReg = setupPluginRegistry("alpha", "beta", "gamma");
    const scope = createSessionPluginScope(pluginReg, ["alpha", "gamma"]);

    expect(scope.listActive()).toHaveLength(2);
    expect(scope.isActive("alpha")).toBe(true);
    expect(scope.isActive("beta")).toBe(false);
    expect(scope.isActive("gamma")).toBe(true);
  });

  it("silently drops invalid IDs from the initial set", () => {
    const pluginReg = setupPluginRegistry("alpha", "beta");
    const scope = createSessionPluginScope(pluginReg, [
      "alpha",
      "nonexistent",
      "also-fake",
    ]);

    expect(scope.listActive()).toHaveLength(1);
    expect(scope.isActive("alpha")).toBe(true);
    expect(scope.isActive("nonexistent")).toBe(false);
  });

  it("excludes disabled plugins when no initial set is provided", () => {
    const pluginReg = setupPluginRegistry("alpha", "beta");
    pluginReg.disable("beta");
    const scope = createSessionPluginScope(pluginReg);

    expect(scope.listActive()).toHaveLength(1);
    expect(scope.isActive("alpha")).toBe(true);
    expect(scope.isActive("beta")).toBe(false);
  });
});

// ── isActive / enable / disable ───────────────────────────────────

describe("SessionPluginScope enable/disable", () => {
  it("enables a previously inactive plugin", () => {
    const pluginReg = setupPluginRegistry("alpha", "beta");
    const scope = createSessionPluginScope(pluginReg, ["alpha"]);

    expect(scope.isActive("beta")).toBe(false);
    scope.enable("beta");
    expect(scope.isActive("beta")).toBe(true);
  });

  it("disables an active plugin", () => {
    const pluginReg = setupPluginRegistry("alpha", "beta");
    const scope = createSessionPluginScope(pluginReg);

    scope.disable("alpha");
    expect(scope.isActive("alpha")).toBe(false);
    expect(scope.listActive()).toHaveLength(1);
  });

  it("throws when enabling a non-existent plugin", () => {
    const pluginReg = setupPluginRegistry("alpha");
    const scope = createSessionPluginScope(pluginReg);

    expect(() => scope.enable("ghost")).toThrow(
      /Cannot enable plugin "ghost"/
    );
  });

  it("disabling a non-existent plugin is a no-op", () => {
    const pluginReg = setupPluginRegistry("alpha");
    const scope = createSessionPluginScope(pluginReg);

    // Should not throw
    scope.disable("ghost");
    expect(scope.listActive()).toHaveLength(1);
  });
});

// ── listActive / listAvailable ────────────────────────────────────

describe("SessionPluginScope listing", () => {
  it("listActive returns only active IDs", () => {
    const pluginReg = setupPluginRegistry("a", "b", "c");
    const scope = createSessionPluginScope(pluginReg, ["a", "c"]);

    const active = scope.listActive();
    expect(active).toContain("a");
    expect(active).toContain("c");
    expect(active).not.toContain("b");
  });

  it("listAvailable returns all globally loaded plugin IDs", () => {
    const pluginReg = setupPluginRegistry("a", "b", "c");
    const scope = createSessionPluginScope(pluginReg, ["a"]);

    const available = scope.listAvailable();
    expect(available).toHaveLength(3);
    expect(available).toContain("a");
    expect(available).toContain("b");
    expect(available).toContain("c");
  });
});

// ── createScopedRuntimeRegistry ───────────────────────────────────

describe("createScopedRuntimeRegistry", () => {
  function setup() {
    const pluginReg = setupPluginRegistry("alpha", "beta");
    const runtimeReg = createRuntimeRegistry();
    runtimeReg.register("alpha", {
      id: "r1",
      pluginId: "alpha",
      kind: "story",
      phase: "story",
      trigger: { mode: "always" },
      tools: [],
      hooks: [],
    });
    runtimeReg.register("beta", {
      id: "r2",
      pluginId: "beta",
      kind: "plugin",
      phase: "post_story",
      trigger: { mode: "always" },
      tools: [],
      hooks: [],
    });
    return { pluginReg, runtimeReg };
  }

  it("listAll returns only runtimes from active plugins", () => {
    const { pluginReg, runtimeReg } = setup();
    const scope = createSessionPluginScope(pluginReg, ["alpha"]);
    const scoped = createScopedRuntimeRegistry(runtimeReg, scope);

    const all = scoped.listAll();
    expect(all).toHaveLength(1);
    expect(all[0].pluginId).toBe("alpha");
  });

  it("getByQualifiedId returns undefined for inactive plugin runtime", () => {
    const { pluginReg, runtimeReg } = setup();
    const scope = createSessionPluginScope(pluginReg, ["alpha"]);
    const scoped = createScopedRuntimeRegistry(runtimeReg, scope);

    expect(scoped.getByQualifiedId("beta:r2")).toBeUndefined();
    expect(scoped.getByQualifiedId("alpha:r1")).toBeDefined();
  });

  it("get returns undefined for inactive plugin", () => {
    const { pluginReg, runtimeReg } = setup();
    const scope = createSessionPluginScope(pluginReg, ["alpha"]);
    const scoped = createScopedRuntimeRegistry(runtimeReg, scope);

    expect(scoped.get("beta", "r2")).toBeUndefined();
    expect(scoped.get("alpha", "r1")).toBeDefined();
  });

  it("listByPlugin returns empty for inactive plugin", () => {
    const { pluginReg, runtimeReg } = setup();
    const scope = createSessionPluginScope(pluginReg, ["alpha"]);
    const scoped = createScopedRuntimeRegistry(runtimeReg, scope);

    expect(scoped.listByPlugin("beta")).toHaveLength(0);
    expect(scoped.listByPlugin("alpha")).toHaveLength(1);
  });

  it("reflects enable mid-session", () => {
    const { pluginReg, runtimeReg } = setup();
    const scope = createSessionPluginScope(pluginReg, ["alpha"]);
    const scoped = createScopedRuntimeRegistry(runtimeReg, scope);

    expect(scoped.listAll()).toHaveLength(1);

    scope.enable("beta");
    expect(scoped.listAll()).toHaveLength(2);
    expect(scoped.getByQualifiedId("beta:r2")).toBeDefined();
  });
});

// ── createScopedToolRegistry ──────────────────────────────────────

describe("createScopedToolRegistry", () => {
  function setup() {
    const pluginReg = setupPluginRegistry("alpha", "beta");
    const toolReg = createToolRegistry();
    toolReg.register("alpha", { id: "t1", kind: "query" }, stubToolHandler);
    toolReg.register("beta", { id: "t2", kind: "mutation" }, stubToolHandler);
    return { pluginReg, toolReg };
  }

  it("listAll returns only tools from active plugins", () => {
    const { pluginReg, toolReg } = setup();
    const scope = createSessionPluginScope(pluginReg, ["alpha"]);
    const scoped = createScopedToolRegistry(toolReg, scope);

    const all = scoped.listAll();
    expect(all).toHaveLength(1);
    expect(all[0].pluginId).toBe("alpha");
  });

  it("getByQualifiedId returns undefined for inactive plugin tool", () => {
    const { pluginReg, toolReg } = setup();
    const scope = createSessionPluginScope(pluginReg, ["alpha"]);
    const scoped = createScopedToolRegistry(toolReg, scope);

    expect(scoped.getByQualifiedId("beta:t2")).toBeUndefined();
    expect(scoped.getByQualifiedId("alpha:t1")).toBeDefined();
  });

  it("get returns undefined for inactive plugin", () => {
    const { pluginReg, toolReg } = setup();
    const scope = createSessionPluginScope(pluginReg, ["beta"]);
    const scoped = createScopedToolRegistry(toolReg, scope);

    expect(scoped.get("alpha", "t1")).toBeUndefined();
    expect(scoped.get("beta", "t2")).toBeDefined();
  });

  it("listByPlugin returns empty for inactive plugin", () => {
    const { pluginReg, toolReg } = setup();
    const scope = createSessionPluginScope(pluginReg, ["beta"]);
    const scoped = createScopedToolRegistry(toolReg, scope);

    expect(scoped.listByPlugin("alpha")).toHaveLength(0);
    expect(scoped.listByPlugin("beta")).toHaveLength(1);
  });

  it("reflects enable mid-session", () => {
    const { pluginReg, toolReg } = setup();
    const scope = createSessionPluginScope(pluginReg, ["alpha"]);
    const scoped = createScopedToolRegistry(toolReg, scope);

    expect(scoped.listAll()).toHaveLength(1);

    scope.enable("beta");
    expect(scoped.listAll()).toHaveLength(2);
  });
});

// ── createScopedHookRegistry ──────────────────────────────────────

describe("createScopedHookRegistry", () => {
  function setup() {
    const pluginReg = setupPluginRegistry("alpha", "beta");
    const hookReg = createHookRegistry();
    hookReg.register(
      "alpha",
      { id: "h1", event: "TurnStart", handlerKind: "command" },
      stubHandler,
      100
    );
    hookReg.register(
      "beta",
      { id: "h2", event: "TurnStart", handlerKind: "command" },
      stubHandler,
      200
    );
    hookReg.register(
      "beta",
      { id: "h3", event: "PreToolUse", handlerKind: "command" },
      stubHandler,
      100
    );
    return { pluginReg, hookReg };
  }

  it("getHooksForEvent filters by active scope", () => {
    const { pluginReg, hookReg } = setup();
    const scope = createSessionPluginScope(pluginReg, ["alpha"]);
    const scoped = createScopedHookRegistry(hookReg, scope);

    const hooks = scoped.getHooksForEvent("TurnStart");
    expect(hooks).toHaveLength(1);
    expect(hooks[0].pluginId).toBe("alpha");
  });

  it("listAll returns only hooks from active plugins", () => {
    const { pluginReg, hookReg } = setup();
    const scope = createSessionPluginScope(pluginReg, ["alpha"]);
    const scoped = createScopedHookRegistry(hookReg, scope);

    expect(scoped.listAll()).toHaveLength(1);
  });

  it("returns hooks from all active plugins", () => {
    const { pluginReg, hookReg } = setup();
    const scope = createSessionPluginScope(pluginReg);
    const scoped = createScopedHookRegistry(hookReg, scope);

    const turnStartHooks = scoped.getHooksForEvent("TurnStart");
    expect(turnStartHooks).toHaveLength(2);
    expect(scoped.listAll()).toHaveLength(3);
  });

  it("returns empty for events with no active hooks", () => {
    const { pluginReg, hookReg } = setup();
    const scope = createSessionPluginScope(pluginReg, ["alpha"]);
    const scoped = createScopedHookRegistry(hookReg, scope);

    // beta has the only PreToolUse hook, and it is inactive
    expect(scoped.getHooksForEvent("PreToolUse")).toHaveLength(0);
  });

  it("reflects enable mid-session", () => {
    const { pluginReg, hookReg } = setup();
    const scope = createSessionPluginScope(pluginReg, ["alpha"]);
    const scoped = createScopedHookRegistry(hookReg, scope);

    expect(scoped.getHooksForEvent("TurnStart")).toHaveLength(1);

    scope.enable("beta");
    expect(scoped.getHooksForEvent("TurnStart")).toHaveLength(2);
  });
});

// ── createScopedContextProviders ──────────────────────────────────

describe("createScopedContextProviders", () => {
  function setup() {
    const pluginReg = setupPluginRegistry("alpha", "beta");
    const providers = new Map<string, RegisteredContextProvider>();
    providers.set("alpha:persona", {
      pluginId: "alpha",
      id: "persona",
      handler: async () => ({ persona: "narrator" }),
    });
    providers.set("beta:world-info", {
      pluginId: "beta",
      id: "world-info",
      handler: async () => ({ world: "fantasy" }),
    });
    return { pluginReg, providers };
  }

  it("values() only yields entries from active plugins", () => {
    const { pluginReg, providers } = setup();
    const scope = createSessionPluginScope(pluginReg, ["alpha"]);
    const scoped = createScopedContextProviders(providers, scope);

    const values = Array.from(scoped.values());
    expect(values).toHaveLength(1);
    expect(values[0].pluginId).toBe("alpha");
  });

  it("get() returns undefined for inactive plugin provider", () => {
    const { pluginReg, providers } = setup();
    const scope = createSessionPluginScope(pluginReg, ["alpha"]);
    const scoped = createScopedContextProviders(providers, scope);

    expect(scoped.get("beta:world-info")).toBeUndefined();
    expect(scoped.get("alpha:persona")).toBeDefined();
  });

  it("has() returns false for inactive plugin provider", () => {
    const { pluginReg, providers } = setup();
    const scope = createSessionPluginScope(pluginReg, ["alpha"]);
    const scoped = createScopedContextProviders(providers, scope);

    expect(scoped.has("beta:world-info")).toBe(false);
    expect(scoped.has("alpha:persona")).toBe(true);
  });

  it("size reflects only active providers", () => {
    const { pluginReg, providers } = setup();
    const scope = createSessionPluginScope(pluginReg, ["alpha"]);
    const scoped = createScopedContextProviders(providers, scope);

    expect(scoped.size).toBe(1);
  });

  it("entries() yields only active entries", () => {
    const { pluginReg, providers } = setup();
    const scope = createSessionPluginScope(pluginReg, ["alpha"]);
    const scoped = createScopedContextProviders(providers, scope);

    const entries = Array.from(scoped.entries());
    expect(entries).toHaveLength(1);
    expect(entries[0][0]).toBe("alpha:persona");
  });

  it("forEach iterates only active entries", () => {
    const { pluginReg, providers } = setup();
    const scope = createSessionPluginScope(pluginReg, ["alpha"]);
    const scoped = createScopedContextProviders(providers, scope);

    const visited: string[] = [];
    scoped.forEach((_value, key) => visited.push(key));
    expect(visited).toEqual(["alpha:persona"]);
  });

  it("Symbol.iterator yields only active entries", () => {
    const { pluginReg, providers } = setup();
    const scope = createSessionPluginScope(pluginReg, ["alpha"]);
    const scoped = createScopedContextProviders(providers, scope);

    const keys: string[] = [];
    for (const [key] of scoped) {
      keys.push(key);
    }
    expect(keys).toEqual(["alpha:persona"]);
  });

  it("reflects enable mid-session", () => {
    const { pluginReg, providers } = setup();
    const scope = createSessionPluginScope(pluginReg, ["alpha"]);
    const scoped = createScopedContextProviders(providers, scope);

    expect(scoped.size).toBe(1);

    scope.enable("beta");
    expect(scoped.size).toBe(2);
    expect(scoped.get("beta:world-info")).toBeDefined();
  });
});
