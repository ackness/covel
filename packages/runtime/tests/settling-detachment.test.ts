import { describe, expect, it } from "vitest";
import type { RuntimeManifest } from "@covel/shared";
import { planTurnDetachment } from "../src/schedule/turn-completion.js";

const manifest = (overrides: Partial<RuntimeManifest> = {}): RuntimeManifest =>
  ({
    name: "memory/update",
    pluginId: "memory",
    description: "memory update",
    stage: "post-turn",
    runtimeType: "function",
    handler: "./handler.js",
    outputKind: "plugin",
    trigger: { type: "auto" },
    turnCompletion: { mode: "detached", settle: "before-next-execution" },
    effects: {
      reads: ["plugin-data:self:blocks"],
      writes: ["plugin-data:self:blocks"],
    },
    ...overrides,
  }) as RuntimeManifest;

describe("settling detachment admission", () => {
  it("allows live own-namespace reads only behind the settle barrier", () => {
    const settling = manifest();
    expect(
      planTurnDetachment([settling]).eligibleRuntimeIds.has(settling.name),
    ).toBe(true);
    expect(
      planTurnDetachment([manifest({ turnCompletion: { mode: "detached" } })])
        .eligibleRuntimeIds.size,
    ).toBe(0);
  });

  it.each([
    { stage: "narrative" },
    { outputKind: "story" },
    { runtimeType: "agent" },
    { effects: { reads: ["state:*"], writes: ["plugin-data:self:blocks"] } },
    { effects: { writes: ["state:*"] } },
  ] as Partial<RuntimeManifest>[])(
    "preserves the detached boundary for %j",
    (override) => {
      expect(
        planTurnDetachment([manifest(override)]).eligibleRuntimeIds.size,
      ).toBe(0);
    },
  );
});
