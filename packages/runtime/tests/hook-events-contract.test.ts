/**
 * Hook event single-source-of-truth contract (T10).
 *
 * Guards the convergence of the hook event list onto one tuple, `HOOK_EVENTS`
 * in `@covel/shared`. If anyone adds, removes, or renames a hook event in just
 * one place, one of these assertions fails:
 *
 *  - `HOOK_EVENTS` is the canonical 16-event list.
 *  - The runtime engine's dispatch map `HOOK_SEMANTICS` is keyed by exactly the
 *    same set — i.e. every event actually wired into the pipeline derives from
 *    the SSOT (and vice versa: no orphan semantic without an event).
 *  - The plugin frontmatter validator (`hookDeclarationSchema`) accepts exactly
 *    the SSOT events and rejects anything else — so `VALID_HOOK_EVENTS` in the
 *    loader / schemas cannot silently drift.
 */

import { describe, it, expect } from "vitest";
import { HOOK_EVENTS, hookDeclarationSchema } from "@covel/shared";
import { HOOK_SEMANTICS } from "../src/hooks/types.js";

const EXPECTED_EVENTS = [
  "SessionStart",
  "TurnStart",
  "PreCompaction",
  "PostCompaction",
  "PreSchedule",
  "PreRuntime",
  "PostContextAssembly",
  "PreLLMCall",
  "PostLLMResponse",
  "PostRuntime",
  "PreToolUse",
  "PostToolUse",
  "PreStateCommit",
  "PostStateCommit",
  "TurnStop",
  "SessionEnd",
] as const;

describe("hook events single source of truth", () => {
  it("HOOK_EVENTS is the canonical, unique 16-event list", () => {
    expect(HOOK_EVENTS).toHaveLength(16);
    expect(new Set(HOOK_EVENTS).size).toBe(16);
    expect([...HOOK_EVENTS].sort()).toEqual([...EXPECTED_EVENTS].sort());
  });

  it("HOOK_SEMANTICS keys exactly match HOOK_EVENTS (every wired event derives from the SSOT)", () => {
    const semanticEvents = Object.keys(HOOK_SEMANTICS).sort();
    expect(semanticEvents).toEqual([...HOOK_EVENTS].sort());
  });

  it("every event has a known semantic", () => {
    for (const event of HOOK_EVENTS) {
      expect(["first", "sequential", "parallel", "stream"]).toContain(
        HOOK_SEMANTICS[event],
      );
    }
  });

  it("hookDeclarationSchema accepts every SSOT event", () => {
    for (const event of HOOK_EVENTS) {
      const parsed = hookDeclarationSchema.safeParse({
        event,
        handler: "./hook.js",
      });
      expect(parsed.success).toBe(true);
    }
  });

  it("hookDeclarationSchema rejects an unknown event", () => {
    const parsed = hookDeclarationSchema.safeParse({
      event: "NotARealEvent",
      handler: "./hook.js",
    });
    expect(parsed.success).toBe(false);
  });
});
