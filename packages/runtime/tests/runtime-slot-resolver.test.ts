import { describe, expect, it } from "vitest";
import type { RuntimeManifest } from "@covel/shared";
import { resolveRuntimeSlot } from "../src/llm/runtime-slot-resolver.js";

function makeManifest(overrides?: Partial<RuntimeManifest>): RuntimeManifest {
  return {
    name: "narrator",
    pluginId: "narrator",
    description: "test",
    stage: "narrative",
    ...overrides,
  };
}

describe("resolveRuntimeSlot", () => {
  it("returns session override when runtime ID matches", () => {
    const manifest = makeManifest({ name: "narrator", model: "fast" });
    const slot = resolveRuntimeSlot(manifest, { narrator: "balance" });
    expect(slot).toBe("balance");
  });

  it("falls back to manifest.model when no session override", () => {
    const manifest = makeManifest({ name: "narrator", model: "fast" });
    const slot = resolveRuntimeSlot(manifest, {});
    expect(slot).toBe("fast");
  });

  it("returns undefined when neither session override nor manifest model is set", () => {
    const manifest = makeManifest({ name: "narrator" });
    const slot = resolveRuntimeSlot(manifest, undefined);
    expect(slot).toBeUndefined();
  });

  it("matches multi-runtime plugin IDs by full runtime name", () => {
    const manifest = makeManifest({
      name: "codex/unlocker",
      pluginId: "codex",
      model: "fast",
    });
    const slot = resolveRuntimeSlot(manifest, {
      "codex/unlocker": "balance",
      "codex/retriever": "fast",
    });
    expect(slot).toBe("balance");
  });

  it("does not fan out plugin-level overrides to individual runtimes", () => {
    const manifest = makeManifest({
      name: "codex/unlocker",
      pluginId: "codex",
      model: "fast",
    });
    // Override key is just "codex" — should not match "codex/unlocker".
    const slot = resolveRuntimeSlot(manifest, { codex: "balance" });
    expect(slot).toBe("fast");
  });

  it("treats empty-string overrides as absent", () => {
    const manifest = makeManifest({ name: "narrator", model: "fast" });
    const slot = resolveRuntimeSlot(manifest, { narrator: "" });
    expect(slot).toBe("fast");
  });

  it("handles undefined sessionOverrides without throwing", () => {
    const manifest = makeManifest({ name: "narrator", model: "fast" });
    expect(resolveRuntimeSlot(manifest, undefined)).toBe("fast");
  });
});
