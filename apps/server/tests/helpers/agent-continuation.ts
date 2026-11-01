import { resolveLoopProfile } from "@covel/runtime";
import {
  resolveAgentOutput,
  type LoadedRuntime,
} from "@covel/shared/plugin-runtime";
import type { SuspensionRecord } from "@covel/store";

/** Capture the same admitted output and correction contract as a real suspension. */
export function suspendedAgentLoop(
  loaded: LoadedRuntime,
): NonNullable<SuspensionRecord["pendingContinuation"]["loop"]> {
  return {
    steps: 1,
    maxSteps: 20,
    rejectionAttempts: 0,
    correctionLimits: resolveLoopProfile(loaded.manifest).corrections,
    outputContract: resolveAgentOutput(loaded),
  };
}
