import { describe, it, expect } from "vitest";
import { LIVE, createCollectingRegistrar } from "@covel/plugin-test-utils";
import register from "../server/index.js";

/**
 * Live tests for core-memory.
 *
 * The memory summarizer now uses LLM tool-calling via PLUGIN.md + tools.
 * The tools themselves are pure logic (no LLM needed), fully covered in unit.test.ts.
 * E2E testing of the full LLM + tool-calling loop requires the kernel runtime-runner.
 * Skipped unless LIVE_LLM_ENABLED=1.
 */
describe.skipIf(!LIVE)("live: core-memory", () => {
  it("registers tools and context provider correctly", () => {
    const { registrar, contributions } = createCollectingRegistrar();
    register(registrar);
    expect(contributions.tools.has("update-memory-archive")).toBe(true);
    expect(contributions.tools.has("record-key-event")).toBe(true);
    expect(contributions.contextProviders.has("memory-archive")).toBe(true);
  });
});
