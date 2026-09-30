import { describe, expect, it, vi } from "vitest";
import type { createGateway, ResolvedSlotConfig } from "@covel/ai-provider";
import { hasServerRuntimeJobCredentials } from "../src/runtime-job-readiness.js";

const slot: ResolvedSlotConfig = {
  presetId: "background",
  provider: "configured",
  protocol: "openai",
  model: "model",
  tag: "text",
  metadata: {},
};

describe("server detached runtime credential readiness", () => {
  it("resolves the requested model through origin-gated env credentials", () => {
    const resolveSlot = vi.fn(() => ({ ...slot, apiKey: "server-key" }));
    expect(
      hasServerRuntimeJobCredentials({ resolveSlot }, "background", {
        configured: "server-key",
      }),
    ).toBe(true);
    expect(resolveSlot).toHaveBeenCalledWith("background", {
      envApiKeys: { configured: "server-key" },
    });
  });

  it.each([
    null,
    slot,
    { ...slot, apiKey: " " },
    { ...slot, headers: { "Content-Type": "application/json" } },
  ])(
    "does not treat an adapter or unresolved credentials as configured (%j)",
    (value) => {
      expect(
        hasServerRuntimeJobCredentials(
          { resolveSlot: () => value },
          undefined,
          { unrelated: "key" },
        ),
      ).toBe(false);
    },
  );

  it("checks complete plugin targets instead of falling back to a server role", () => {
    const resolveSlot = vi.fn(
      (_model: string | undefined, _options: unknown) => null,
    );
    const modelTargets = new Map([
      [
        "plugin-target",
        {
          role: "story",
          provider: "configured",
          model: "plugin-model",
          baseUrl: "https://example.invalid/v1",
          protocol: "openai-chat-v1" as const,
        },
      ],
    ]);
    expect(
      hasServerRuntimeJobCredentials(
        { resolveSlot },
        "plugin-target",
        {},
        modelTargets,
      ),
    ).toBe(false);
    const options = resolveSlot.mock.calls[0]?.[1] as {
      slotOverrides: {
        customPresets: Array<{ model: string; baseUrl: string }>;
      };
    };
    expect(options.slotOverrides.customPresets[0]).toMatchObject({
      model: "plugin-model",
      baseUrl: "https://example.invalid/v1",
    });
  });

  it("accepts configured auth headers but leaves broken bindings queued", () => {
    expect(
      hasServerRuntimeJobCredentials(
        { resolveSlot: () => ({ ...slot, headers: { "X-Api-Key": "key" } }) },
        undefined,
        {},
      ),
    ).toBe(true);
    const broken: Pick<ReturnType<typeof createGateway>, "resolveSlot"> = {
      resolveSlot() {
        throw new Error("missing preset");
      },
    };
    expect(hasServerRuntimeJobCredentials(broken, "removed", {})).toBe(false);
  });
});
