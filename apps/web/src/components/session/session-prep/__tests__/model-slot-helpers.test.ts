import { describe, expect, it } from "vitest";
import { resolveProviderSlot } from "../model-slot-helpers.js";

// The configured slots in this scenario: the user has `gpt-image` but NOT the
// plugin's manifest default `openai-image`.
const configured = new Set(["story", "plugin", "gpt-image"]);
const isMissing = (slot: string) => !configured.has(slot);

describe("resolveProviderSlot", () => {
  it("uses the manifest default when there is no override", () => {
    const r = resolveProviderSlot({
      manifestDefault: "gpt-image",
      override: undefined,
      isMissing,
    });
    expect(r.effectiveSlot).toBe("gpt-image");
    expect(r.missing).toBe(false);
    expect(r.isOverridden).toBe(false);
  });

  it("flags a manifest default that is not configured as missing", () => {
    const r = resolveProviderSlot({
      manifestDefault: "openai-image",
      override: undefined,
      isMissing,
    });
    expect(r.effectiveSlot).toBe("openai-image");
    expect(r.missing).toBe(true);
  });

  it("clears the missing warning once overridden to a configured slot", () => {
    // The reported bug: default `openai-image` is missing, but the player
    // overrides to `gpt-image` which they do have configured.
    const r = resolveProviderSlot({
      manifestDefault: "openai-image",
      override: "gpt-image",
      isMissing,
    });
    expect(r.effectiveSlot).toBe("gpt-image");
    expect(r.missing).toBe(false);
    expect(r.isOverridden).toBe(true);
  });

  it("treats an override equal to the manifest default as not overridden", () => {
    const r = resolveProviderSlot({
      manifestDefault: "gpt-image",
      override: "gpt-image",
      isMissing,
    });
    expect(r.isOverridden).toBe(false);
  });

  it("reports an override to a still-missing slot as missing", () => {
    const r = resolveProviderSlot({
      manifestDefault: "gpt-image",
      override: "dashscope-image",
      isMissing,
    });
    expect(r.effectiveSlot).toBe("dashscope-image");
    expect(r.missing).toBe(true);
    expect(r.isOverridden).toBe(true);
  });

  it("is not missing when neither default nor override is set", () => {
    const r = resolveProviderSlot({
      manifestDefault: undefined,
      override: undefined,
      isMissing,
    });
    expect(r.effectiveSlot).toBeUndefined();
    expect(r.missing).toBe(false);
    expect(r.isOverridden).toBe(false);
  });
});
