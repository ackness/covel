/**
 * Function handler context factory for direct handler unit tests.
 */

import type { FunctionHandlerContext } from "@covel/shared/plugin-runtime";
import type {
  FunctionStoreView,
  PluginRandom,
} from "@covel/plugin-handlers-utils";
export interface ManualFunctionContextOptions extends Partial<
  Omit<FunctionHandlerContext, "pluginId" | "store">
> {
  readonly pluginId: string;
  /** Stub only the reads exercised by this test; omitted methods reject. */
  readonly store?: Partial<FunctionStoreView>;
}

/** `ctx.random` for a test: the same numbers on every run, within each range. */
export function makeRandom(seed = 1): PluginRandom {
  let state = seed >>> 0;
  return {
    int(min, max) {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
      return min + Math.floor((state / 2 ** 32) * (max - min));
    },
  };
}

export function makeManualFunctionContext({
  pluginId,
  runtimeId = pluginId,
  sessionId = `sess-${pluginId}`,
  turnId = `turn-${pluginId}`,
  playerMessage = "",
  locale,
  store = {},
  manualPayload = {},
  random = makeRandom(),
  ...capabilities
}: ManualFunctionContextOptions): FunctionHandlerContext {
  return {
    sessionId,
    turnId,
    pluginId,
    runtimeId,
    playerMessage,
    ...(locale ? { locale } : {}),
    store: {
      getPluginData: missingRead("getPluginData"),
      listPluginData: missingRead("listPluginData"),
      listPlayerInputs: missingRead("listPlayerInputs"),
      getSession: missingRead("getSession"),
      listTurnMessages: missingRead("listTurnMessages"),
      readTurnMessages: missingRead("readTurnMessages"),
      ...store,
    },
    recursiveCall: async () => {
      throw new Error("recursiveCall is not configured for this test context");
    },
    recursionDepth: 0,
    manualPayload,
    random,
    ...capabilities,
  };
}

function missingRead(method: keyof FunctionStoreView) {
  return async (): Promise<never> => {
    throw new Error(`store.${method} is not configured for this test context`);
  };
}
