import { describe, it, expect } from "vitest";
import { LIVE, createCollectingRegistrar } from "@covel/plugin-test-utils";
import register from "../server/index.js";

/**
 * Live tests for core-init-wizard.
 *
 * The init-wizard now uses LLM tool-calling via PLUGIN.md + emit-character-form tool.
 * The tool itself is pure logic (no LLM needed), fully covered in unit.test.ts.
 * E2E testing of the full LLM + tool-calling loop requires the kernel runtime-runner.
 * Skipped unless LIVE_LLM_ENABLED=1.
 */
describe.skipIf(!LIVE)("live: core-init-wizard", () => {
  it("registers emit-character-form tool correctly", () => {
    const { registrar, contributions } = createCollectingRegistrar();
    register(registrar);
    expect(contributions.tools.has("emit-character-form")).toBe(true);
  });
});
