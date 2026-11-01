import { describe, it, expect } from "vitest";
import reviewOutput from "../server/review-output.js";
describe("canonical output review", () => {
  const canonical = {
    schemaVersion: 1,
    summary: "Rain stopped.",
    entities: [],
    relations: [],
    events: [],
    statements: [],
  };
  const ctx = { runtimeId: "world-ir", locale: "en-US" };
  const payload = {
    output: canonical,
    toolCall: { id: "final", name: "submit-output" },
    toolResults: [
      { toolCallId: "work", toolName: "submit-world-facts", output: canonical },
    ],
  };
  it("rejects a changed result and accepts correction without repeating work", () => {
    expect(
      reviewOutput(ctx, {
        ...payload,
        output: { ...canonical, invented: true },
      }).replace?.correction,
    ).toContain("Do not repeat");
    expect(reviewOutput(ctx, payload)).toEqual({ action: "continue" });
    expect(payload.toolResults).toHaveLength(1);
  });
  it("uses only its own business result and runtime", () => {
    expect(
      reviewOutput(ctx, {
        ...payload,
        toolResults: [{ ...payload.toolResults[0], toolName: "other-tool" }],
      }).replace?.correction,
    ).toBeTruthy();
    expect(
      reviewOutput({ ...ctx, runtimeId: "other" }, { ...payload, output: {} }),
    ).toEqual({ action: "continue" });
    expect(
      reviewOutput({ ...ctx, locale: "zh-CN" }, { ...payload, output: {} })
        .replace?.correction,
    ).toContain("不要重复");
  });
});
