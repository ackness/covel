/** Public, structural types for a plugin server entry module. */
import type { z, ZodType } from "zod";
import type {
  ExtensionAttributeDefinition,
  ExtensionPointId,
  ExtensionWorldModel,
  PluginExtensionApi,
} from "./extension-points.js";
import type { FunctionStoreView } from "./function-runtime.js";
import type { JsonValue, MediaReference } from "./types.js";
import type { withPendingProposals } from "./tool-result.js";
import type { PluginMessageContext, PluginMessages } from "./messages.js";
export type { PluginToolResult } from "./tool-result.js";

export type HookEventName =
  | "SessionStart"
  | "TurnStart"
  | "PreCompaction"
  | "PostCompaction"
  | "PreSchedule"
  | "PreRuntime"
  | "PostContextAssembly"
  | "PreLLMCall"
  | "PostLLMResponse"
  | "PostRuntime"
  | "PreToolUse"
  | "PostToolUse"
  | "PreStateCommit"
  | "PostStateCommit"
  | "TurnStop"
  | "SessionEnd";

export type HookEnforce = "pre" | "normal" | "post";
export interface PluginHookContext {
  readonly signal?: AbortSignal;
  readonly event: HookEventName;
  readonly sessionId: string;
  /** Empty for `SessionStart` and `SessionEnd`, which fire outside a turn. */
  readonly turnId: string;
  /** The session's content locale; a session host always supplies it. */
  readonly locale?: string;
  /**
   * Plugin of the runtime the event is about, not the plugin that registered
   * the handler. Set together with `runtimeId` for every event that concerns
   * one runtime; payloads do not repeat the identity.
   */
  readonly pluginId?: string;
  /** Runtime the event is about; see `pluginId`. */
  readonly runtimeId?: string;
  readonly activePluginIds?: ReadonlySet<string>;
  readonly getOwnSettings?: () => Readonly<Record<string, unknown>>;
}
export type PluginHookResult<P> =
  | { readonly action: "continue"; readonly replace?: Partial<P> }
  | { readonly action: "abort"; readonly reason: string };
export type PluginHookHandler<P = unknown> = (
  context: PluginHookContext,
  payload: P,
) => Promise<PluginHookResult<P>>;
export interface PluginHookOptions {
  readonly match?: (payload: unknown) => boolean;
  readonly timeoutMs?: number;
  readonly enforce?: HookEnforce;
}

/** A domain write produced by a tool and committed by the kernel. */
export interface PluginProposalPayloads {
  "narrative.append": { readonly content: string; readonly kind: string };
  "state.patch": {
    readonly table: string;
    readonly field: string;
    readonly value: unknown;
    readonly reason?: string;
  };
  "event.emit": {
    readonly topic: string;
    readonly data: Readonly<Record<string, unknown>>;
  };
  "interaction.request": {
    readonly interactionId: string;
    readonly type: "form" | "choice" | "confirmation";
    readonly title?: string;
    readonly data: Readonly<Record<string, unknown>>;
    readonly narrativeTemplate?: string;
  };
  "ui.render": {
    readonly parts: readonly {
      readonly id: string;
      readonly type: string;
      readonly status: "pending" | "streaming" | "success" | "error" | "paused";
      readonly content: unknown;
      readonly retry?: { readonly count: number; readonly lastError?: string };
    }[];
    readonly layout?: "stream" | "split" | "overlay";
    readonly status?: "pending" | "streaming" | "success" | "error" | "paused";
  };
  "asset.generate": {
    readonly ref: MediaReference;
    readonly modality: string;
    readonly meta?: Readonly<Record<string, unknown>>;
  };
  "plugin.data": {
    readonly namespace: string;
    readonly key: string;
    readonly value: unknown;
  };
  "plugin.data.batch": {
    readonly items: readonly PluginProposalPayloads["plugin.data"][];
  };
  "plugin.data.delete": { readonly namespace: string; readonly key: string };
  "character.upsert": {
    readonly id: string;
    readonly name: string;
    readonly type?: string;
    readonly description?: string;
    readonly fields?: unknown;
    readonly version?: number;
    readonly expectedVersion?: number;
    readonly createdAt?: string;
  };
  "character.schema.set": {
    readonly types: readonly string[];
    readonly attributes: readonly ExtensionAttributeDefinition[];
  };
  "dimension.initialize": {
    readonly definitions: import("./world-dimensions.js").ExtensionWorldDimensions;
  };
  "dimension.update": {
    readonly updates: readonly {
      readonly id: string;
      readonly expectedVersion: number;
      readonly value: JsonValue;
      readonly reason?: string;
    }[];
    readonly source?: {
      readonly resultId: string;
      readonly turnNumber: number;
    };
    readonly readVersions?: Readonly<Record<string, number>>;
    readonly settlement?: "no-change" | "manual" | "skipped";
  };
  "lorebook.upsert": {
    readonly entries: readonly {
      readonly id: string;
      readonly content: string;
      readonly strategy: "constant" | "selective";
      readonly position?: string;
      readonly insertionOrder?: number;
      readonly enabled?: boolean;
      readonly keys?: readonly string[];
      readonly extra?: unknown;
    }[];
  };
}
export type PluginProposalType = keyof PluginProposalPayloads;
export type PluginProposalFor<K extends PluginProposalType> = {
  readonly id: string;
  readonly type: K;
  readonly source: { readonly pluginId: string; readonly runtimeId: string };
  readonly turnId: string;
  readonly sessionId: string;
  readonly payload: PluginProposalPayloads[K];
  readonly timestamp: string;
};
export type PluginProposal = {
  [K in PluginProposalType]: PluginProposalFor<K>;
}[PluginProposalType];
export type PluginToolStore = FunctionStoreView;
export interface PluginToolContext {
  readonly sessionId: string;
  readonly turnId: string;
  readonly pluginId: string;
  readonly runtimeId: string;
  /**
   * The session's content language. Text a tool stores or returns is written
   * in this language; use `translate(context, "English text")`.
   */
  readonly locale?: string;
  /** This plugin's translations, read by `translate` and `labelText`. */
  readonly messages?: PluginMessages;
  /** Scoped, owned reads including earlier writes; absent in stateless hosts. */
  readonly store?: PluginToolStore;
  readonly world?: ExtensionWorldModel;
  readonly upstreamProposals?: readonly PluginProposal[];
  /** Pass cancellation to external requests and check it before side effects. */
  readonly signal?: AbortSignal;
  /** Authoritative inputs explicitly declared by this runtime. */
  readonly inputSlots?: Readonly<Record<string, PluginInputSlot>>;
  /** Earlier writes in this execution; ordinary scoped reads already include them. */
  readonly pendingProposals?: readonly PluginProposal[];
  /**
   * Player messages recorded in this session, setup-form submissions included;
   * absent outside a turn. Monotonic, but not the scheduler's logical turn
   * (`startTurn` / `interval` count committed main-loop player turns).
   */
  readonly turnNumber?: number;
  /**
   * The scheduler's logical turn: committed main-loop player turns plus one.
   * Setup and the opening continuation share turn 1 with the first message;
   * `startTurn` and `interval` gates count in these units.
   */
  readonly logicalTurn?: number;
  /** Topics emitted earlier in this tool loop, used for event deduplication. */
  readonly emittedEventTopics?: readonly string[];
  /** Dice and other game rolls; a session host always supplies it. */
  readonly random?: import("./function-runtime.js").PluginRandom;
}
export type PluginInputSlot =
  | {
      readonly cardinality: "one";
      readonly value: unknown;
      readonly source: PluginInputSource;
    }
  | {
      readonly cardinality: "all";
      readonly items: readonly {
        readonly value: unknown;
        readonly source: PluginInputSource;
      }[];
    };
export interface PluginInputSource {
  readonly pluginId: string;
  readonly runtimeId: string;
  readonly resultId: string;
}
export interface PluginToolModule<
  TParams extends ZodType = ZodType,
  TOutput = unknown,
> {
  readonly _type: "covel-tool";
  readonly name: string;
  readonly description: string;
  readonly parametersSchema: TParams;
  readonly jsonSchema: Readonly<Record<string, unknown>>;
  execute(
    params: z.input<TParams>,
    context: PluginToolContext,
  ): Promise<TOutput>;
}
export interface PluginToolDefinition<TParams extends ZodType, TOutput> {
  readonly name: string;
  readonly description: string;
  readonly parameters: TParams;
  execute(
    params: z.infer<TParams>,
    context: PluginToolContext,
  ): Promise<TOutput>;
}
export interface PluginToolkit {
  readonly tool: <TParams extends ZodType, TOutput>(
    definition: PluginToolDefinition<TParams, TOutput>,
  ) => PluginToolModule<TParams, TOutput>;
  readonly z: typeof z;
  readonly shortId: (
    prefix: string,
    label: string,
    sessionId: string,
    random?: import("./function-runtime.js").PluginRandom,
  ) => string;
  readonly shortIdBatch: (
    prefix: string,
    labels: readonly string[],
    sessionId: string,
    random?: import("./function-runtime.js").PluginRandom,
  ) => string[];
  readonly withPendingProposals: typeof withPendingProposals;
}

export interface PluginServiceClient {
  discover(contract: string): Promise<
    readonly {
      readonly pluginId: string;
      readonly name: string;
      readonly contract: string;
      readonly description?: string;
    }[]
  >;
  call(
    request: {
      readonly pluginId: string;
      readonly name: string;
      readonly contract: string;
      readonly input: unknown;
    },
    options?: { readonly signal?: AbortSignal; readonly timeoutMs?: number },
  ): Promise<unknown>;
}
export interface PluginServiceContext {
  readonly callerPluginId: string;
  readonly signal: AbortSignal;
  readonly services: PluginServiceClient;
  readonly gateway?: PluginServiceGateway;
  readonly utils?: PluginHttp;
}
export type PluginEvaluationJson =
  | string
  | number
  | boolean
  | null
  | readonly PluginEvaluationJson[]
  | { readonly [key: string]: PluginEvaluationJson };
export type PluginEvaluationValue =
  | string
  | null
  | readonly PluginEvaluationJson[]
  | { readonly [key: string]: PluginEvaluationJson };
export type PluginEvaluationQuestion =
  | {
      readonly type: "boolean";
      readonly instructions?: PluginEvaluationValue;
      readonly criteria?: {
        readonly true?: PluginEvaluationValue;
        readonly false?: PluginEvaluationValue;
      };
    }
  | {
      readonly type: "choice";
      readonly instructions?: PluginEvaluationValue;
      readonly criteria: Readonly<Record<string, PluginEvaluationValue>>;
    }
  | {
      readonly type: "score";
      readonly instructions?: PluginEvaluationValue;
      readonly criteria: readonly PluginEvaluationValue[];
    };
export type PluginEvaluationQuestions = Readonly<
  Record<string, PluginEvaluationQuestion>
>;
export type PluginEvaluationAnswer<Q extends PluginEvaluationQuestion> =
  Q extends { type: "boolean" }
    ? { type: "boolean"; probability: number }
    : Q extends { type: "choice"; criteria: infer C }
      ? {
          type: "choice";
          choice: keyof C & string;
          probabilities?: Record<keyof C & string, number>;
        }
      : {
          type: "score";
          score: number;
          probabilities?: Record<string, number>;
        };
/** Public methods available on the optional service gateway. */
export interface PluginServiceGateway {
  evaluate?<const Q extends PluginEvaluationQuestions>(input: {
    readonly state: PluginEvaluationValue;
    readonly questions: Q;
    readonly presetId?: string;
    readonly signal?: AbortSignal;
  }): Promise<{
    readonly model: string;
    readonly answers: { [K in keyof Q]: PluginEvaluationAnswer<Q[K]> };
    readonly usage: PluginUsageSummary;
    readonly providerMetadata?: Record<string, unknown>;
    readonly provider?: string;
  }>;
  generateText(input: {
    readonly presetId?: string;
    readonly prompt?: string;
    readonly system?: string;
    readonly messages?: readonly {
      readonly role: "system" | "user" | "assistant";
      readonly content: string;
    }[];
    readonly defaults?: {
      readonly reasoningEffort?: "disabled";
      readonly toolChoice?: "required" | { readonly name: string };
    };
    /** Output ceiling for this call; never raises the slot's configured budget. */
    readonly maxOutputTokens?: number;
    readonly providerRequestMetadata?: Readonly<Record<string, unknown>>;
    /**
     * Typed settings by provider ID or protocol ID, for example
     * `{ "anthropic-messages-v1": { thinking: { type: "disabled" } } }`. The
     * gateway checks them and applies those of the target the call reaches.
     */
    readonly providerOptions?: Readonly<
      Record<string, Readonly<Record<string, unknown>>>
    >;
    readonly signal?: AbortSignal;
  }): Promise<{
    readonly text: string;
    readonly reasoningContent?: string;
    /**
     * `stop`, `length` (cut at a limit), `tool_calls`, `content_filter`,
     * `error` or `other`: the same words for every provider.
     */
    readonly finishReason: string;
    readonly usage: PluginUsageSummary;
    readonly model?: string;
    readonly provider?: string;
  }>;
  generateObject<T = unknown>(input: {
    readonly presetId?: string;
    readonly schema: Readonly<Record<string, unknown>>;
    readonly prompt?: string;
    readonly system?: string;
    readonly messages?: readonly {
      readonly role: "system" | "user" | "assistant";
      readonly content: string;
    }[];
    readonly defaults?: {
      readonly reasoningEffort?: "disabled";
      readonly toolChoice?: "required" | { readonly name: string };
    };
    /** Output ceiling for this call; never raises the slot's configured budget. */
    readonly maxOutputTokens?: number;
    readonly providerRequestMetadata?: Readonly<Record<string, unknown>>;
    readonly signal?: AbortSignal;
  }): Promise<{
    readonly object: T;
    readonly reasoningContent?: string;
    readonly finishReason: string;
    readonly usage: PluginUsageSummary;
    readonly model?: string;
    readonly provider?: string;
  }>;
  resolveSlot(input: {
    readonly presetId?: string;
    readonly fallbackTag?: string;
  }): {
    readonly presetId: string;
    readonly provider: string;
    readonly protocol: string;
    readonly baseUrl?: string;
    readonly apiKey?: string;
    readonly headers?: Readonly<Record<string, string>>;
    readonly model: string;
    readonly tag: string;
    readonly metadata: Readonly<Record<string, unknown>>;
    /** Effective limits, present when the model declares a context window. */
    readonly limits?: {
      readonly contextWindow: number;
      readonly maxOutputTokens: number;
    };
  } | null;
  generateImage?(input: {
    presetId?: string;
    prompt: string;
    negativePrompt?: string;
    size?: string;
    quality?: string;
    n?: number;
    background?: "transparent" | "opaque";
    signal?: AbortSignal;
  }): Promise<{
    target: {
      readonly provider: string;
      readonly model: string;
      readonly protocol: string;
      readonly baseUrl?: string;
      readonly metadata: Readonly<Record<string, unknown>>;
    };
    images: ReadonlyArray<
      | { kind: "bytes"; bytes: Uint8Array; mime: string }
      | { kind: "url"; url: string; mime: string }
    >;
    warnings: readonly string[];
  }>;
  synthesizeSpeech?(input: {
    presetId?: string;
    text: string;
    voice?: string;
    format?: string;
    signal?: AbortSignal;
  }): Promise<{
    audio: { mimeType: string; data: Uint8Array };
    warnings: readonly string[];
  }>;
  composeMusic?(input: {
    presetId?: string;
    prompt: string;
    lyrics?: string;
    instrumental?: boolean;
    durationSeconds?: number;
    format?: string;
    signal?: AbortSignal;
  }): Promise<{
    audio: { mimeType: string; data: Uint8Array };
    warnings: readonly string[];
  }>;
  transcribeAudio?(input: {
    presetId?: string;
    audio: { data: Uint8Array; mimeType: string; fileName?: string };
    signal?: AbortSignal;
  }): Promise<{
    text: string;
    usage?: PluginUsageSummary | null;
    model?: string;
    provider?: string;
    warnings: readonly string[];
  }>;
}
export interface PluginServiceDefinition<Input, Output> {
  readonly name: string;
  readonly contract: string;
  readonly description?: string;
  readonly input: { parse(value: unknown): Input };
  readonly output: { parse(value: unknown): Output };
  readonly handler: (
    input: Input,
    context: PluginServiceContext,
  ) => Promise<Output> | Output;
}

export interface PluginRpcStore {
  getSession(): Promise<unknown>;
  listTurnMessages(): Promise<
    ReadonlyArray<{
      readonly turnId: string;
      readonly content: string;
      readonly order: number;
      readonly pendingInput?: unknown;
      readonly name?: string;
    }>
  >;
  savePlayerInput(input: {
    readonly id: string;
    readonly turnId: string;
    readonly formId: string;
    readonly values: Record<string, unknown>;
    readonly createdAt: string;
  }): Promise<void>;
  setPluginData?(record: {
    readonly namespace: string;
    readonly key: string;
    readonly value: unknown;
    readonly createdAt?: string;
    readonly updatedAt?: string;
  }): Promise<void>;
  getPluginData?(namespace: string, key: string): Promise<unknown>;
  listPluginData?(
    namespace: string,
  ): Promise<ReadonlyArray<{ key: string; value: unknown }>>;
}
export interface PluginRpcContext {
  readonly sessionId: string;
  readonly pluginId: string;
  readonly action?: string;
  readonly runtimeId?: string;
  readonly store: PluginRpcStore;
  /** Dice and other game rolls; a session host always supplies it. */
  readonly random?: import("./function-runtime.js").PluginRandom;
  readonly locale?: string;
  /** This plugin's translations, read by `translate` and `labelText`. */
  readonly messages?: PluginMessages;
  readonly command?: {
    readonly command: string;
    readonly canonical: string;
    readonly raw: string;
    readonly argv: readonly string[];
    readonly args: Readonly<Record<string, unknown>>;
    readonly invocationId: string;
    readonly commandId: string;
    readonly source: "composer" | "plugin-ui";
  };
  readonly environment?: {
    readonly capturedAt: string;
    readonly session?: {
      readonly id: string;
      readonly worldId?: string;
      readonly status: string;
      readonly phase?: string;
      readonly locale?: string;
    };
    readonly activeRuntimes?: readonly {
      readonly id: string;
      readonly pluginId: string;
      readonly runtimeType: string;
      readonly outputKind: string;
      readonly stage?: string;
      readonly outputContract?: string;
      readonly model?: {
        readonly slot: string;
        readonly resolved?: string;
        readonly source: "session-override" | "manifest" | "default";
      };
    }[];
  };
  readonly emit?: (event: { type: string; data: unknown }) => void;
}
export type PluginRpcHandler = (
  payload: unknown,
  context: PluginRpcContext,
) => Promise<unknown>;
export interface PluginRpcOptions {
  readonly description?: string;
  readonly trustLevel?: "builtin" | "community";
}
/**
 * One reason a form was refused. With a `field` (a field `name` of the form)
 * the message is shown under that field; without one, or when the form has no
 * such field, it is about the form as a whole.
 */
export interface PluginFormIssue {
  readonly field?: string;
  readonly message: string;
}

/**
 * Returns the text shown to the player when the submitted values are refused:
 * a string for the form as a whole, or one or more `{ field, message }` to
 * place a message under a field. Return `undefined` to accept the values.
 * `context` carries the session's language and the plugin's translations for
 * it; pass it to `translate`.
 */
export type PluginFormValidator = (
  values: Readonly<Record<string, unknown>>,
  data: unknown,
  context: PluginMessageContext & { readonly locale: string },
) => string | PluginFormIssue | readonly PluginFormIssue[] | undefined;

export interface PluginHttp {
  validateBaseUrl(url: string): {
    readonly ok: boolean;
    readonly reason?: string;
  };
  fetchWithRetry(
    input: string | URL,
    init?: RequestInit & {
      readonly maxRetries?: number;
      readonly signal?: AbortSignal;
    },
  ): Promise<Response>;
}

export interface PluginUsageSummary {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cachedInputTokens?: number;
  readonly cacheWriteInputTokens?: number;
}
export type PluginOperationMode =
  | "text"
  | "object"
  | "stream"
  | "embed"
  | "image"
  | "speech"
  | "transcription"
  | "music"
  | "evaluate";
export type PluginProviderProtocol =
  | "openai-chat-v1"
  | "openai-responses-v1"
  | "anthropic-messages-v1"
  | "google-generative-ai-v1"
  | "typesafe-systemone-v1"
  | "openrouter-decisions-v1"
  | "vercel-evaluation-v4"
  | "openai-decisions-v1";
export interface PluginModelCapability {
  input: ("text" | "image" | "audio" | "video" | "file")[];
  output: ("text" | "image" | "audio" | "video" | "embedding" | "evaluation")[];
  features?: (
    | "function_calling"
    | "structured_output"
    | "streaming"
    | "reasoning"
    | "vision"
    | "prompt_caching"
    | "web_search"
    | "computer_use"
  )[];
  contextWindow?: number;
  maxOutputTokens?: number;
  pricing?: {
    inputPerMToken?: number;
    outputPerMToken?: number;
    imageInputPerMToken?: number;
    audioInputPerMToken?: number;
    audioOutputPerMToken?: number;
    perImage?: number;
  };
}
export interface PluginProviderConfig {
  /** A built-in protocol, or a text wire's `<pluginId>/<wireId>`. */
  protocol?: PluginProviderProtocol | (string & {});
  requestObservation?: {
    provider: string;
    protocol: string;
    onRequest(request: {
      readonly schemaVersion: 1;
      readonly provider: string;
      readonly protocol: string;
      readonly body: Readonly<Record<string, unknown>>;
      readonly complete: boolean;
      readonly omittedFieldCount: number;
      readonly startedAt: string;
      readonly durationMs: number;
      readonly transportAttempt: number;
      readonly statusCode?: number;
      readonly failed?: true;
    }): void;
  };
  baseUrl?: string;
  apiKey?: string;
  headers?: Record<string, string>;
  signal?: AbortSignal;
  cacheStrategy?: "anthropic-explicit" | "auto-prefix" | "none";
}
export interface PluginModelRequestContext {
  profile: {
    id: string;
    tier: "small" | "medium" | "large" | "embed-default";
    provider: string;
    model: string;
    contextWindow: number;
    latencyClass: string;
    costClass: string;
    supportedModes: PluginOperationMode[];
  };
  preset: {
    id: string;
    name: string;
    provider: string;
    protocol?: PluginProviderProtocol | (string & {});
    model: string;
    tier: "small" | "medium" | "large";
    baseUrl?: string;
    fallbackPresetIds?: string[];
    supportedModes: PluginOperationMode[];
    enabled: boolean;
    isDefault?: boolean;
    scope?: string;
    defaultSlot?: string;
    providerRequestMetadata?: Record<string, unknown>;
    capability?: PluginModelCapability;
    tag?: string;
    embeddingFormat?: "openai" | "nemotron-multimodal";
    requestScoped?: boolean;
  } | null;
  mode: PluginOperationMode;
}
export interface PluginImageWire {
  readonly id: string;
  generate(
    config: PluginProviderConfig,
    params: {
      model: string;
      prompt: string;
      negativePrompt?: string;
      size?: string;
      quality?: string;
      n?: number;
      background?: "transparent" | "opaque";
      providerRequestMetadata?: Record<string, unknown>;
    },
    context?: PluginModelRequestContext,
  ): Promise<{
    images: (
      | { kind: "bytes"; bytes: Uint8Array; mime: string }
      | { kind: "url"; url: string; mime: string }
    )[];
    usage: PluginUsageSummary | null;
    warnings: string[];
  }>;
}
export interface PluginSpeechWire {
  readonly id: string;
  synthesize(
    config: PluginProviderConfig,
    params: {
      model: string;
      text: string;
      voice?: string;
      format?: string;
      providerRequestMetadata?: Record<string, unknown>;
    },
    context?: PluginModelRequestContext,
  ): Promise<{
    audio: { mimeType: string; data: Uint8Array };
    usage: PluginUsageSummary | null;
    warnings: string[];
  }>;
}
export interface PluginTranscriptionWire {
  readonly id: string;
  transcribe(
    config: PluginProviderConfig,
    params: {
      model: string;
      audio: { data: Uint8Array; mimeType: string; fileName?: string };
      providerRequestMetadata?: Record<string, unknown>;
    },
    context?: PluginModelRequestContext,
  ): Promise<{
    text: string;
    usage: PluginUsageSummary | null;
    warnings: string[];
  }>;
}
/**
 * A music provider's request and response format. A provider that answers
 * with a job to poll does the polling inside `compose`, under the abort signal
 * of `config`: the caller gets the finished audio or an error.
 */
export interface PluginMusicWire {
  readonly id: string;
  compose(
    config: PluginProviderConfig,
    params: {
      model: string;
      prompt: string;
      lyrics?: string;
      instrumental?: boolean;
      durationSeconds?: number;
      format?: string;
      providerRequestMetadata?: Record<string, unknown>;
    },
    context?: PluginModelRequestContext,
  ): Promise<{
    audio: { mimeType: string; data: Uint8Array };
    usage: PluginUsageSummary | null;
    warnings: string[];
  }>;
}
export interface PluginTextMessage {
  role: string;
  content:
    | string
    | null
    | readonly (
        | { type: "text"; text: string }
        | { type: "image"; image: { url?: string; mimeType?: string } }
      )[];
  /** Calls the assistant made; the tool's answers follow as `tool` messages. */
  toolCalls?: { id: string; name: string; arguments: string }[];
  toolCallId?: string;
  /** Reasoning of an earlier assistant turn, for providers that want it back. */
  reasoningContent?: string;
}
export interface PluginTextParams {
  model: string;
  messages: PluginTextMessage[];
  tools?: {
    type: "function";
    function: {
      name: string;
      description?: string;
      parameters?: Record<string, unknown>;
    };
  }[];
  /** `toolChoice` the runtime asks for when the slot sets none. */
  defaults?: {
    reasoningEffort?: "disabled";
    toolChoice?: "required" | { name: string };
  };
  responseFormat?: { type: "json_schema"; schema: Record<string, unknown> };
  /** The slot's and the call's native fields, `parameterOverrides` included. */
  providerRequestMetadata?: Record<string, unknown>;
}
export interface PluginTextResult {
  text: string;
  /** The provider's own word is accepted; the gateway unifies it. */
  finishReason: string;
  usage: PluginUsageSummary;
  toolCalls?: { id: string; name: string; arguments: string }[];
  reasoningContent?: string;
}
export type PluginTextStreamEvent =
  | { type: "text-delta"; textDelta: string }
  | { type: "reasoning-delta"; reasoningDelta: string }
  /** A fragment of a tool call's arguments arrived; it carries no call. */
  | { type: "tool-argument-delta" }
  | { type: "tool-call"; id: string; name: string; arguments: string }
  /** Last event of every stream. */
  | {
      type: "done";
      finishReason: string;
      usage: PluginUsageSummary;
      reasoningContent?: string;
    };
/**
 * A text protocol this plugin provides. A model slot whose `protocol` is
 * `<pluginId>/<id>` sends its text, object and stream calls through it. The
 * wire owns the HTTP (`covel.http.fetchWithRetry`): `config` carries the
 * slot's endpoint and key, which must not reach a result, a log or the UI.
 */
export interface PluginTextWire {
  readonly id: string;
  /** Name in the settings UI. Default: the ID. */
  readonly label?: string;
  generateText(
    config: PluginProviderConfig,
    params: PluginTextParams,
    context?: PluginModelRequestContext,
  ): Promise<PluginTextResult>;
  streamText(
    config: PluginProviderConfig,
    params: PluginTextParams,
    context?: PluginModelRequestContext,
  ): AsyncIterable<PluginTextStreamEvent>;
  /** Model IDs the endpoint offers, for the settings UI. */
  listModels?(
    config: PluginProviderConfig,
    signal?: AbortSignal,
  ): Promise<string[]>;
}
export interface PluginWireModule {
  readonly image?: readonly PluginImageWire[];
  readonly speech?: readonly PluginSpeechWire[];
  readonly transcription?: readonly PluginTranscriptionWire[];
  readonly music?: readonly PluginMusicWire[];
  readonly text?: readonly PluginTextWire[];
}

/** Registrations are valid only while the entry factory is running. */
export interface PluginAPI extends PluginExtensionApi {
  readonly signal: AbortSignal;
  readonly pluginId: string;
  readonly toolkit: PluginToolkit;
  readonly http: PluginHttp;
  onDispose(cleanup: () => void | Promise<void>): void;
  registerService<I, O>(definition: PluginServiceDefinition<I, O>): void;
  registerTool(toolModule: PluginToolModule): void;
  on(
    event: HookEventName,
    handler: PluginHookHandler,
    options?: PluginHookOptions,
  ): void;
  registerRpc(
    action: string,
    handler: PluginRpcHandler,
    options?: PluginRpcOptions,
  ): void;
  registerFormValidator(name: string, validator: PluginFormValidator): void;
  registerWires(wires: PluginWireModule): void;
}

export type PluginEntryFactory = (covel: PluginAPI) => void | Promise<void>;

// Keep known point ids visible from this entry surface for editor navigation.
export type PluginKnownExtensionPoint = ExtensionPointId;
