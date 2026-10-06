/**
 * Function handler context factory for direct handler unit tests.
 */

import type { FunctionHandlerContext } from "@covel/shared/plugin-runtime";
import type {
  FunctionStoreView,
  PluginRandom,
  ProgressReporter,
} from "@covel/plugin-handlers-utils";
import type {
  InputSlot,
  RuntimeActivation,
  ExecutionContext,
} from "@covel/shared";

export interface ManualFunctionContextOptions {
  readonly pluginId: string;
  readonly runtimeId?: string;
  readonly sessionId?: string;
  readonly turnId?: string;
  readonly playerMessage?: string;
  readonly locale?: string;
  /** Stub only the reads exercised by this test; omitted methods reject. */
  readonly store?: Partial<FunctionStoreView>;
  readonly manualPayload?: Readonly<Record<string, unknown>>;
  /** Provenance-wrapped input bindings exposed as `ctx.inputs`. */
  readonly inputs?: Readonly<Record<string, InputSlot>>;
  /** Canonical activation exposed as `ctx.activation`. */
  readonly activation?: RuntimeActivation;
  /** Execution identity exposed as `ctx.execution`. */
  readonly execution?: ExecutionContext;
  /** Wire the real-time progress channel for tests exercising `ctx.progress`. */
  readonly progress?: ProgressReporter;
  /** `ctx.random`; the default is `makeRandom()`. */
  readonly random?: PluginRandom;
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
  inputs,
  activation,
  execution,
  progress,
  random = makeRandom(),
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
    ...(inputs ? { inputs } : {}),
    ...(activation ? { activation } : {}),
    ...(execution ? { execution } : {}),
    ...(progress ? { progress } : {}),
    random,
  };
}

function missingRead(method: keyof FunctionStoreView) {
  return async (): Promise<never> => {
    throw new Error(`store.${method} is not configured for this test context`);
  };
}
