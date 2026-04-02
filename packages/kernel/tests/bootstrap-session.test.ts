import { describe, it, expect } from "vitest";
import { bootstrapKernel, createPermissiveTrustPolicy } from "../src/index.js";
import { createPluginHost } from "@covel/plugin-runtime";
import type { KernelInput } from "@covel/shared";
import type { GatewayLike } from "@covel/runtime";
import type { TrustPolicy } from "../src/trust/trust-policy.js";

function createStubGateway(): GatewayLike {
  return {
    async generateText() {
      return {
        text: "The hero bravely stepped forward.",
        finishReason: "stop",
        usage: { inputTokens: 50, outputTokens: 20 },
      };
    },
    async *streamText() {
      yield { type: "text-delta" as const, textDelta: "Hello " };
      yield {
        type: "done" as const,
        finishReason: "stop",
        usage: { inputTokens: 10, outputTokens: 5 },
      };
    },
  };
}

const baseInput: KernelInput = {
  runId: "run-1",
  branchId: "branch-1",
  actorId: "player-1",
  type: "user.input",
  payload: { text: "I attack the dragon" },
};

describe("bootstrapKernel", () => {
  it("returns a KernelInstance with createSession", () => {
    const host = createPluginHost();
    const gateway = createStubGateway();

    const instance = bootstrapKernel({ pluginHost: host, gateway });

    expect(instance.createSession).toBeTypeOf("function");
    expect(instance.pluginHost).toBe(host);
    expect(instance.gateway).toBe(gateway);
    expect(instance.trustPolicy).toBeDefined();
  });

  it("uses permissive trust policy by default", () => {
    const host = createPluginHost();
    const gateway = createStubGateway();

    const instance = bootstrapKernel({ pluginHost: host, gateway });

    const decision = instance.trustPolicy.canExecuteRuntime({
      runtimeId: "test",
      pluginId: "test",
      kind: "story",
    });
    expect(decision.allowed).toBe(true);
  });

  it("accepts a custom trust policy", () => {
    const host = createPluginHost();
    const gateway = createStubGateway();

    const customPolicy: TrustPolicy = {
      canExecuteRuntime: () => ({ allowed: false, reason: "blocked" }),
      canCallTool: () => ({ allowed: true }),
      canCommitProposal: () => ({ allowed: true }),
    };

    const instance = bootstrapKernel({
      pluginHost: host,
      gateway,
      trustPolicy: customPolicy,
    });

    expect(instance.trustPolicy).toBe(customPolicy);
  });
});

describe("KernelSession", () => {
  it("creates isolated sessions with independent context", () => {
    const host = createPluginHost();
    const gateway = createStubGateway();
    const instance = bootstrapKernel({ pluginHost: host, gateway });

    const session1 = instance.createSession({ state: { hp: 100 } });
    const session2 = instance.createSession({ state: { hp: 50 } });

    expect(session1.getContext().state).toEqual({ hp: 100 });
    expect(session2.getContext().state).toEqual({ hp: 50 });

    // Mutating one session doesn't affect the other
    session1.setContext({ state: { hp: 0 } });
    expect(session1.getContext().state).toEqual({ hp: 0 });
    expect(session2.getContext().state).toEqual({ hp: 50 });
  });

  it("can initialize with partial context", () => {
    const host = createPluginHost();
    const gateway = createStubGateway();
    const instance = bootstrapKernel({ pluginHost: host, gateway });

    const session = instance.createSession({ world: { name: "Testland" } });
    expect(session.getContext().world).toEqual({ name: "Testland" });
    expect(session.getContext().state).toBeUndefined();
  });

  it("can create a session with no initial context", () => {
    const host = createPluginHost();
    const gateway = createStubGateway();
    const instance = bootstrapKernel({ pluginHost: host, gateway });

    const session = instance.createSession();
    expect(session.getContext()).toEqual({});
  });

  it("executes a turn on a session", async () => {
    const host = createPluginHost();
    const gateway = createStubGateway();
    const instance = bootstrapKernel({ pluginHost: host, gateway });
    const session = instance.createSession();

    const result = await session.executeTurn(baseInput);

    expect(result.runId).toBe("run-1");
    expect(result.turnId).toBeTruthy();
    expect(result.locale).toBe("zh-CN");
  });

  it("getContext returns a snapshot (not a live reference)", () => {
    const host = createPluginHost();
    const gateway = createStubGateway();
    const instance = bootstrapKernel({ pluginHost: host, gateway });
    const session = instance.createSession({ state: { hp: 100 } });

    const snapshot = session.getContext();
    session.setContext({ state: { hp: 0 } });

    // Snapshot should not have changed
    expect(snapshot.state).toEqual({ hp: 100 });
    expect(session.getContext().state).toEqual({ hp: 0 });
  });
});

describe("TrustPolicy integration", () => {
  it("blocks runtime execution when trust policy denies", async () => {
    const host = createPluginHost();
    const gateway = createStubGateway();

    // Register a runtime
    host.runtimeRegistry.register("story-plugin", {
      id: "narrator",
      pluginId: "story-plugin",
      kind: "story",
      phase: "story",
      trigger: { mode: "always" },
      tools: [],
      hooks: [],
    });
    host.pluginRegistry.add(
      {
        schemaVersion: "1.0",
        id: "story-plugin",
        displayName: "Story",
        version: "0.1.0",
        author: "test",
        description: "Story plugin",
        defaultLocale: "zh-CN",
        supportedLocales: ["zh-CN"],
      },
      "/tmp/story-plugin"
    );

    // Block all runtimes
    const blockAllPolicy: TrustPolicy = {
      canExecuteRuntime: () => ({ allowed: false, reason: "testing block" }),
      canCallTool: () => ({ allowed: true }),
      canCommitProposal: () => ({ allowed: true }),
    };

    const instance = bootstrapKernel({
      pluginHost: host,
      gateway,
      trustPolicy: blockAllPolicy,
    });
    const session = instance.createSession();

    const progressEvents: Array<{ type: string; detail?: string }> = [];
    const result = await session.executeTurn(baseInput, {
      onProgress: (evt) => {
        progressEvents.push({ type: evt.type, detail: evt.detail });
      },
    });

    // No proposals should have been generated since runtime was blocked
    expect(result.proposals).toHaveLength(0);
    expect(result.render.blocks).toHaveLength(0);

    // Should have emitted a runtime.failed progress event
    const failedEvent = progressEvents.find((e) => e.type === "runtime.failed");
    expect(failedEvent).toBeDefined();
    expect(failedEvent!.detail).toContain("trust policy");
  });

  it("createPermissiveTrustPolicy allows everything", () => {
    const policy = createPermissiveTrustPolicy();

    expect(policy.canExecuteRuntime({ runtimeId: "x", pluginId: "y", kind: "z" }).allowed).toBe(true);
    expect(policy.canCallTool({ toolId: "x", pluginId: "y", runtimeId: "z", kind: "mutation" }).allowed).toBe(true);
    expect(policy.canCommitProposal({ proposalId: "x", pluginId: "y", runtimeId: "z", items: [] }).allowed).toBe(true);
  });
});
