/**
 * Streaming-delta forwarder — the agent loop's single narrative outlet.
 *
 * Wraps `AgentLoopDeps.onDelta` with the per-run identity and the delta
 * counter the `message.completed` trace event reports, so the loop body
 * hands the request layer one `forward` function instead of an inline
 * closure over mutable state. Client disconnects are swallowed: the loop
 * keeps streaming to capture full content for persistence.
 */

import type { AgentLoopDeps } from "../turn-executor/turn-executor-types.js";

export interface DeltaForwarder {
  /** Forward one text delta to the SSE consumer (no-throw). */
  readonly forward: (textDelta: string) => Promise<void>;
  /**
   * How many chunks the narrative was assembled from. Non-streaming
   * runtimes keep this at 0; trace consumers treat that as "not streamed".
   */
  readonly count: () => number;
}

export function createDeltaForwarder(params: {
  readonly onDelta: AgentLoopDeps["onDelta"];
  readonly runtimeId: string;
  readonly pluginId: string;
}): DeltaForwarder {
  let deltaCount = 0;
  return {
    forward: async (textDelta: string): Promise<void> => {
      deltaCount++;
      try {
        await params.onDelta?.({
          runtimeId: params.runtimeId,
          pluginId: params.pluginId,
          textDelta,
        });
      } catch {
        // Client disconnected — keep streaming to capture full content.
      }
    },
    count: () => deltaCount,
  };
}
