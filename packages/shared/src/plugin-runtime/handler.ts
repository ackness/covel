import type {
  NestedTurnResult,
  RecursiveCallDelta,
  InputSlot,
} from "../index.js";
import type {
  PluginFunctionContext,
  PluginFunctionHandler,
  PluginAgentGuard,
} from "@covel/plugin-handlers-utils";
import type { PluginRuntimeGateway, PluginRuntimeUtils } from "./services.js";

export type {
  FunctionStoreView,
  PluginTurnMessage,
  PluginDataWriter,
  PluginLogger,
  PluginRandom,
  ProgressEffect,
  ProgressReporter,
  PluginAgentGuardResult as AgentGuardResult,
  PluginSessionView,
  PluginSetupRuntimeState,
  PluginExecutionInfo,
} from "@covel/plugin-handlers-utils";

/**
 * The context the host builds for function handlers and agent guards: the
 * public `PluginFunctionContext`, with host types where the kernel has a more
 * precise one. It adds no field; `sdk-alignment.ts` in
 * `@covel/plugin-test-utils` fails when the two drift apart.
 */
export interface FunctionHandlerContext extends PluginFunctionContext {
  readonly world?: import("../proposals/world-model.js").WorldModelView;
  readonly services?: import("./plugin-services.js").PluginServiceClient;
  /** Generation is available only when the host supplies a gateway. */
  readonly gateway?: PluginRuntimeGateway;
  readonly utils?: PluginRuntimeUtils;
  /** Nested execution shares the parent's session and atomic commit boundary. */
  readonly recursiveCall: (
    delta: RecursiveCallDelta,
    opts?: { readonly reason?: string },
  ) => Promise<NestedTurnResult>;
  readonly inputs?: Readonly<Record<string, InputSlot>>;
  readonly exports?: Readonly<Record<string, InputSlot>>;
}

export type FunctionHandler = PluginFunctionHandler<FunctionHandlerContext>;
export type AgentGuard = PluginAgentGuard<FunctionHandlerContext>;
