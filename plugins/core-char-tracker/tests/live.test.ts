import { describe, it, expect } from "vitest";
import { LIVE, createCollectingRegistrar } from "@covel/plugin-test-utils";
import register from "../server/index.js";

/**
 * Live tests for core-char-tracker.
 *
 * The char-tracker now uses LLM-based extraction via tool calls.
 * The upsert-character tool itself is pure logic (no LLM needed),
 * so it's fully covered in unit.test.ts.
 *
 * These live tests are reserved for end-to-end scenarios that require
 * the full kernel + LLM pipeline.
 * Skipped unless LIVE_LLM_ENABLED=1.
 */
describe.skipIf(!LIVE)("live: core-char-tracker", () => {
  it("registers upsert-character tool correctly", () => {
    const { registrar, contributions } = createCollectingRegistrar();
    register(registrar);
    expect(contributions.tools.has("upsert-character")).toBe(true);
  });
});
