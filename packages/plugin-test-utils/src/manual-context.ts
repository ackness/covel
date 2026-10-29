/**
 * Function handler context factory for direct handler unit tests.
 */

import type { FunctionHandlerContext } from "@covel/shared/plugin-runtime";
import type {
  SubagentRequest,
  SubagentResult,
  SubagentRunApi,
} from "@covel/shared";
import type {
  FunctionStoreView,
  PluginRandom,
} from "@covel/plugin-handlers-utils";
import { validateRandomIntRange } from "@covel/plugin-handlers-utils";

/** Scripted `ctx.agents.run` answers: a list used in order, or a function. */
export type ScriptedSubagentResults =
  | readonly SubagentResult[]
  | ((request: SubagentRequest) => SubagentResult | Promise<SubagentResult>);

export interface ManualFunctionContextOptions extends Partial<
  Omit<FunctionHandlerContext, "pluginId" | "store">
> {
  readonly pluginId: string;
  /** Stub only the reads exercised by this test; omitted methods reject. */
  readonly store?: Partial<FunctionStoreView>;
  /**
   * Answers for `ctx.agents.run`. Without it (and without `agents`) the
   * context has no `agents`, like a guard's.
   */
  readonly subagents?: ScriptedSubagentResults;
}

/**
 * A `ctx.agents` stub. A list answers the calls in order; a call past its end
 * resolves `not-found`. `requests` records every request, copied.
 */
export function makeScriptedAgents(results: ScriptedSubagentResults): {
  readonly agents: SubagentRunApi;
  readonly requests: readonly SubagentRequest[];
} {
  const requests: SubagentRequest[] = [];
  let next = 0;
  return {
    requests,
    agents: {
      async run(request) {
        requests.push(structuredClone(request));
        if (typeof results === "function")
          return structuredClone(await results(request));
        const result = results[next++];
        return result
          ? structuredClone(result)
          : {
              ok: false,
              error: {
                code: "not-found",
                message: "No scripted sub-agent result is left",
              },
            };
      },
    },
  };
}

/** `ctx.random` for a test: the same numbers on every run, within each range. */
export function makeRandom(seed = 1): PluginRandom {
  let state = seed >>> 0;
  return {
    int(min, max) {
      validateRandomIntRange(min, max);
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
  subagents,
  ...capabilities
}: ManualFunctionContextOptions): FunctionHandlerContext {
  return {
    ...(subagents ? { agents: makeScriptedAgents(subagents).agents } : {}),
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
    session: { lastPlayerInput: null },
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
