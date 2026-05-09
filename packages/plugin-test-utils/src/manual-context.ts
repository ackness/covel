/**
 * Function handler context factory for direct handler unit tests.
 */

import type { FunctionHandlerContext } from "@covel/plugin-loader";

export interface ManualFunctionContextOptions {
  readonly pluginId: string;
  readonly runtimeId?: string;
  readonly sessionId?: string;
  readonly turnId?: string;
  readonly playerMessage?: string;
  readonly locale?: string;
  readonly store?: unknown;
  readonly completedResults?: ReadonlyMap<string, unknown>;
  readonly config?: Readonly<Record<string, unknown>>;
  readonly manualPayload?: Readonly<Record<string, unknown>>;
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
  config = {},
  manualPayload = {},
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
    config,
    recursiveCall: async () => {
      throw new Error("recursiveCall is not configured for this test context");
    },
    recursionDepth: 0,
    manualPayload,
  };
}
