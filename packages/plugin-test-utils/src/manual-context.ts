/**
 * Function handler context factory for direct handler unit tests.
 */

import type {
  FunctionHandlerContext,
  ProgressReporter,
} from "@covel/plugin-loader";

export interface ManualFunctionContextOptions {
  readonly pluginId: string;
  readonly runtimeId?: string;
  readonly sessionId?: string;
  readonly turnId?: string;
  readonly playerMessage?: string;
  readonly locale?: string;
  readonly store?: unknown;
  readonly completedResults?: ReadonlyMap<string, unknown>;
  readonly manualPayload?: Readonly<Record<string, unknown>>;
  /** Wire the real-time progress channel for tests exercising `ctx.progress`. */
  readonly progress?: ProgressReporter;
}

export function makeManualFunctionContext({
  pluginId,
  runtimeId = pluginId,
  sessionId = `sess-${pluginId}`,
  turnId = `turn-${pluginId}`,
  playerMessage = "",
  locale,
  store = {},
  completedResults = new Map(),
  manualPayload = {},
  progress,
}: ManualFunctionContextOptions): FunctionHandlerContext {
  return {
    sessionId,
    turnId,
    pluginId,
    runtimeId,
    playerMessage,
    ...(locale ? { locale } : {}),
    store,
    completedResults,
    recursiveCall: async () => {
      throw new Error("recursiveCall is not configured for this test context");
    },
    recursionDepth: 0,
    manualPayload,
    ...(progress ? { progress } : {}),
  };
}
