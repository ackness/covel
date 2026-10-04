export type {
  PluginExtensionContext,
  PluginExtensionDefinition,
  ExtensionPluginDataRecord,
} from "../extension-points/index.js";
export type { WorldModelView } from "../proposals/world-model.js";

export type {
  PluginServiceClient,
  PluginServiceContext,
  PluginServiceDefinition,
  PluginServiceDescriptor,
} from "./plugin-services.js";

/** Execution contracts only; no discovery, filesystem or provider implementation. */
export type {
  PluginRuntimeGateway,
  PluginEvaluationInput,
  ResolvedSlotForPlugin,
  SlotTokenLimits,
  PluginRuntimeUtils,
  IngestUrlOptions,
  MediaContext,
  ImageGenerateInput,
  ImageGenerateOutput,
  ImageGenerationTarget,
  ImagesContext,
  SpeechGenerateInput,
  SpeechGenerateOutput,
  SpeechTranscribeInput,
  SpeechContext,
  MusicGenerateInput,
  MusicGenerateOutput,
  MusicContext,
  AssetProgressInput,
} from "./services.js";
export type {
  EvaluationQuestions,
  EvaluationResult,
  EvaluationValue,
  EvaluationQuestion,
  EvaluationAnswer,
} from "../evaluation.js";
export type {
  FunctionHandlerContext,
  FunctionStoreView,
  PluginTurnMessage,
  PluginDataWriter,
  PluginLogger,
  ProgressEffect,
  ProgressReporter,
  FunctionHandler,
  AgentGuardResult,
  AgentGuard,
} from "./handler.js";
export type { LoadedRuntime } from "./loaded-runtime.js";
export type PluginSource = "builtin" | "community";
export type { PluginLlmSlot, PluginLlmConfig } from "./model-config.js";
