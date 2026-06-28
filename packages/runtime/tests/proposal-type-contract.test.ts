/**
 * Proposal-type contract guard (T6).
 *
 * Regression guard for the historical three-list drift: `record.upsert` and
 * `narrative.template` were declared in the `ProposalType` union and advertised
 * by the discovery endpoint, but had no commit handler — committing either one
 * failed at runtime with "unknown proposal type" (discovery lied to clients).
 *
 * `PROPOSAL_TYPES` (the single source of truth, which discovery now advertises
 * verbatim) must equal exactly the set of proposal types that have a commit
 * handler. If they ever diverge again, this test fails.
 */

import { describe, it, expect } from "vitest";
import { PROPOSAL_TYPES } from "@covel/shared";
import type { KernelStore } from "../src/session/session-kernel.js";
import { createCommitHandlers } from "../src/commit/session-commit-handlers.js";

const sorted = (values: readonly string[]): string[] => [...values].sort();

describe("proposal type contract", () => {
  // The store is only used inside handler bodies, never when building the map,
  // so a bare stub is enough to read the registered proposal-type keys.
  const handlerTypes = Object.keys(
    createCommitHandlers({} as unknown as KernelStore),
  );

  it("advertised proposal types exactly match the commit-handler registry", () => {
    expect(sorted([...PROPOSAL_TYPES])).toEqual(sorted(handlerTypes));
  });

  it("does not advertise or handle the removed drifted types", () => {
    for (const removed of ["record.upsert", "narrative.template"]) {
      expect([...PROPOSAL_TYPES] as string[]).not.toContain(removed);
      expect(handlerTypes).not.toContain(removed);
    }
  });

  it("committing a removed/unknown proposal type is rejected, not silently dropped", async () => {
    const { createCommitPipeline } =
      await import("../src/session/session-kernel.js");
    const pipeline = createCommitPipeline({
      async addTraceEvent() {},
    } as unknown as KernelStore);

    const result = await pipeline.commit({
      id: "p-removed",
      // Deliberately a type that no longer exists in the union.
      type: "record.upsert",
      source: { pluginId: "x", runtimeId: "x" },
      turnId: "t",
      sessionId: "s",
      payload: {},
      timestamp: new Date().toISOString(),
    } as never);

    expect(result.committed).toBe(false);
    expect(result.error).toContain("unknown proposal type");
  });
});
