import { describe, expect, it } from "vitest";
import { validateRuntimeManifestSemantics } from "../src/index.js";

const codes = (
  m: Parameters<typeof validateRuntimeManifestSemantics>[0],
): string[] => validateRuntimeManifestSemantics(m).map((d) => d.code);

describe("schedulable-missing-stage", () => {
  it("warns for an auto function runtime with neither stage nor priority", () => {
    // "Installed but silently never runs" — the exact third-party trap.
    expect(
      codes({
        name: "x/worker",
        trigger: { type: "auto" },
        runtimeType: "function",
        handler: "./h.js",
      }),
    ).toContain("schedulable-missing-stage");
  });

  it("warns when no trigger is declared at all (defaults to auto)", () => {
    expect(codes({ name: "x/agent", model: "fast" })).toContain(
      "schedulable-missing-stage",
    );
  });

  it("does not warn when a stage is declared", () => {
    expect(
      codes({
        name: "x/worker",
        trigger: { type: "auto" },
        runtimeType: "function",
        handler: "./h.js",
        stage: "post-turn",
      }),
    ).not.toContain("schedulable-missing-stage");
  });

  it("does not warn when a legacy priority derives the stage", () => {
    // pregame / world-init/schema-gen loader-gated exception path.
    expect(
      codes({ name: "pregame", trigger: { type: "scheduled" }, priority: 10 }),
    ).not.toContain("schedulable-missing-stage");
  });

  it("does not warn for the pure UI-panel idiom (memory plugin shape)", () => {
    expect(
      codes({ name: "memory", ui: { right: ["./ui/panel.json"] } }),
    ).toEqual([]);
  });

  it("does not warn for a pure hook-carrier declaration", () => {
    expect(codes({ name: "x/hooks", hooks: [{ event: "TurnStart" }] })).toEqual(
      [],
    );
  });

  it("does not warn for an entry-only server module (cost-gate shape)", () => {
    expect(codes({ name: "cost-gate", entry: "./server/index.js" })).toEqual(
      [],
    );
  });

  it("does not warn for manual or event runtimes (never stage-scheduled)", () => {
    expect(codes({ name: "x/btn", trigger: { type: "manual" } })).toEqual([]);
    expect(
      codes({ name: "x/follower", trigger: { type: "event", topic: "t" } }),
    ).toEqual([]);
  });
});
