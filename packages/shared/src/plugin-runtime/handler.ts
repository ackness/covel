import type {
  NestedTurnResult,
  RecursiveCallDelta,
  InputSlot,
  RuntimeActivation,
  ExecutionContext,
} from "../index.js";
import type {
  PluginFunctionContext,
  PluginFunctionHandler,
  PluginAgentGuard,
} from "@covel/plugin-handlers-utils";
import type {
  PluginRuntimeGateway,
  PluginRuntimeUtils,
  MediaContext,
  ImagesContext,
  SpeechContext,
  MusicContext,
  AssetProgressInput,
} from "./services.js";

export type {
  FunctionStoreView,
  PluginTurnMessage,
  PluginDataWriter,
  PluginLogger,
  ProgressEffect,
  ProgressReporter,
  PluginAgentGuardResult as AgentGuardResult,
} from "@covel/plugin-handlers-utils";

/** Host capabilities extend the same scoped context used by public plugin authors. */
export interface FunctionHandlerContext extends PluginFunctionContext {
  readonly session?: {
    readonly lastPlayerInput:
      import("../types/message.js").PlayerInputSubmission | null;
  };
  readonly world?: import("../proposals/world-model.js").WorldModelView;
  readonly services?: import("./plugin-services.js").PluginServiceClient;
  /** Generation is available only when the host supplies a gateway. */
  readonly gateway?: PluginRuntimeGateway;
  readonly utils?: PluginRuntimeUtils;
  readonly media?: MediaContext;
  readonly images?: ImagesContext;
  readonly speech?: SpeechContext;
  readonly music?: MusicContext;
  readonly assetProgress?: (progress: AssetProgressInput) => Promise<void>;
  /** Nested execution shares the parent's session and atomic commit boundary. */
  readonly recursiveCall: (
    delta: RecursiveCallDelta,
    opts?: { readonly reason?: string },
  ) => Promise<NestedTurnResult>;
  readonly recursionDepth: number;
  readonly inputs?: Readonly<Record<string, InputSlot>>;
  readonly exports?: Readonly<Record<string, InputSlot>>;
  readonly activation?: RuntimeActivation;
  readonly execution?: ExecutionContext;
}

export type FunctionHandler = PluginFunctionHandler<FunctionHandlerContext>;
export type AgentGuard = PluginAgentGuard<FunctionHandlerContext>;
