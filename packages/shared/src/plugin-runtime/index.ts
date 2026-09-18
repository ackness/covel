/** Execution contracts only; no discovery, filesystem or provider implementation. */
export type {
  PluginRuntimeGateway,
  ResolvedSlotForPlugin,
  PluginRuntimeUtils,
  IngestUrlOptions,
  MediaContext,
  ImageGenerateInput,
  ImageGenerateOutput,
  ImagesContext,
  SpeechGenerateInput,
  SpeechGenerateOutput,
  SpeechTranscribeInput,
  SpeechContext,
  AssetProgressInput,
} from "./services.js";
export type {
  FunctionHandlerContext,
  FunctionStoreView,
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
