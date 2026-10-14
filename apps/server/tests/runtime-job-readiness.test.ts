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

  it("treats a keyless model on this machine as ready, and no other keyless model", () => {
    const ready = (baseUrl: string) =>
      hasServerRuntimeJobCredentials(
        { resolveSlot: () => ({ ...slot, apiKey: undefined, baseUrl }) },
        "background",
        {},
      );
    expect(ready("http://localhost:11434/v1")).toBe(true);
    expect(ready("http://127.0.0.1:3425/v1")).toBe(true);
    expect(ready("https://localhost.example.com/v1")).toBe(false);
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

  it("resolves the job's role with the server keys only", () => {
    const resolveSlot = vi.fn(
      (_model: string | undefined, _options: unknown) => null,
    );
    expect(
      hasServerRuntimeJobCredentials({ resolveSlot }, "memory", {
        configured: "key",
      }),
    ).toBe(false);
    expect(resolveSlot).toHaveBeenCalledWith("memory", {
      envApiKeys: { configured: "key" },
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
