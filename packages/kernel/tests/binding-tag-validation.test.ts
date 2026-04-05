/**
 * 测试 kernel 在 runtimeBindings 中绑定了 tag 不兼容的 slot 时，
 * 应拒绝该绑定（返回 undefined presetId），而非传入错误的 presetId。
 *
 * 场景：text 运行时被绑定到 image slot → 应被忽略，presetId 为 undefined。
 */

import { describe, it, expect } from "vitest";
import { bootstrapKernel } from "../src/kernel.js";
import { createPluginHost } from "@covel/plugin-runtime";
import type { GatewayLike } from "@covel/runtime";
import type { SlotRegistry } from "@covel/ai-provider";

// ── Helpers ───────────────────────────────────────────────────────────

function makeGateway(): GatewayLike & { capturedPresetIds: (string | undefined)[] } {
  const capturedPresetIds: (string | undefined)[] = [];
  return {
    capturedPresetIds,
    async generateText(input) {
      capturedPresetIds.push(input.presetId);
      return { text: "ok", finishReason: "stop", usage: { inputTokens: 1, outputTokens: 1 } };
    },
    async *streamText(input) {
      capturedPresetIds.push(input.presetId);
      yield { type: "text-delta" as const, textDelta: "ok" };
      yield { type: "done" as const, finishReason: "stop", usage: { inputTokens: 1, outputTokens: 1 } };
    },
  };
}

function makeSlotRegistry(): SlotRegistry {
  const slots: Record<string, { presetId: string; tag: string }> = {
    "text-slot": { presetId: "preset-text", tag: "text" },
    "image-slot": { presetId: "preset-image", tag: "image" },
  };
  return {
    configure: () => {},
    resolveSlot: (id) => slots[id]?.presetId,
    listSlotsByTag: (tag) =>
      Object.entries(slots)
        .filter(([, v]) => v.tag === tag)
        .map(([slotId, v]) => ({ slotId, presetId: v.presetId, tag: v.tag } as any)),
    getSlotTag: (id) => slots[id]?.tag,
    getParameterOverrides: () => undefined,
    listSlots: () => slots as any,
  };
}

function makeHost() {
  const host = createPluginHost();
  host.pluginRegistry.add(
    { schemaVersion: "1.0", id: "test-plugin", displayName: "Test", version: "0.1.0", author: "test", description: "", defaultLocale: "zh-CN", supportedLocales: ["zh-CN"] },
    "/virtual/test-plugin"
  );
  host.runtimeRegistry.register("test-plugin", {
    id: "text-runtime",
    pluginId: "test-plugin",
    kind: "story",
    phase: "story",
    priority: 400,
    trigger: { mode: "always" },
    providerTag: "text",  // text runtime
    tools: [],
    hooks: [],
  });
  return host;
}

describe("kernel binding tag validation", () => {
  it("should use presetId when tag matches (text runtime → text slot)", async () => {
    const gateway = makeGateway();
    const host = makeHost();
    const slotRegistry = makeSlotRegistry();

    const instance = bootstrapKernel({ pluginHost: host, gateway, slotRegistry });
    const session = instance.createSession();

    await session.executeTurn(
      { type: "user.input", content: "hello", runId: "r1", branchId: "b1" },
      { runtimeBindings: { "test-plugin:text-runtime": "text-slot" } }
    );

    // text runtime bound to text slot → presetId should be "preset-text"
    expect(gateway.capturedPresetIds).toContain("preset-text");
  });

  it("should reject binding when tag is incompatible (text runtime → image slot)", async () => {
    const gateway = makeGateway();
    const host = makeHost();
    const slotRegistry = makeSlotRegistry();

    const instance = bootstrapKernel({ pluginHost: host, gateway, slotRegistry });
    const session = instance.createSession();

    await session.executeTurn(
      { type: "user.input", content: "hello", runId: "r1", branchId: "b1" },
      { runtimeBindings: { "test-plugin:text-runtime": "image-slot" } }
    );

    // text runtime bound to image slot → tag mismatch → presetId should be undefined
    expect(gateway.capturedPresetIds).not.toContain("preset-image");
    expect(gateway.capturedPresetIds.every((id) => id === undefined || id !== "preset-image")).toBe(true);
  });
});
