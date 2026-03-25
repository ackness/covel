import { randomUUID } from "node:crypto";
import { resolve } from "node:path";

import { createArchiveService, createInMemoryArchiveLineageStore, createInMemoryReindexMarkStore } from "../../../modules/archive/src/index.js";
import { CommandBus, CommandRegistry, createSlashCommandSpec } from "../../../modules/command-system/src/index.js";
import { FlowEngine } from "../../../modules/flow-engine/src/index.js";
import { createIngestionRegistry } from "../../../modules/memory-rag/src/index.js";
import { createModelGateway, createModelProfileRegistry, createProviderRegistry, type ModelProfile, type PresetMetadata } from "../../../modules/model-gateway/src/index.js";
import { createObservability } from "../../../modules/observability/src/index.js";
import { PackageRuntime } from "../../../modules/package-runtime/src/index.js";
import { createInMemoryStorageRepositories, createPostgresStoragePort } from "../../../modules/storage/src/index.js";
import { DEFAULT_LOCALE, type SupportedLocale } from "../../../modules/contracts/src/index.js";
import { STORY_NARRATION_TASK } from "../../../modules/domain/src/index.js";
import type { PersistedPresetMetadata, PersistedPresetRecord } from "../../../modules/storage/src/index.js";
import {
  createLocaleSystemInstruction,
  translateCommandDescription
} from "./locale.js";

function createIdFactory() {
  return (kind: string) => `${kind}_${randomUUID()}`;
}

const DEFAULT_ENABLED_PACKAGE_NAMES = [
  "core-archive",
  "core-character-card",
  "core-debug-commands",
  "core-guide",
  "core-memory-rag",
  "core-persona",
  "core-presets",
  "core-worldbook"
] as const;

function createDemoAdapter() {
  return {
    async generateText() {
      return {
        text: "demo response from the in-memory provider",
        finishReason: "stop",
        usage: {
          inputTokens: 0,
          outputTokens: 0
        }
      };
    },
    async generateObject(_config: unknown, params: { schema: { parse(value: unknown): unknown } }) {
      return {
        object: params.schema.parse({
          title: "demo",
          mood: "calm"
        }),
        finishReason: "stop",
        usage: {
          inputTokens: 0,
          outputTokens: 0
        }
      };
    },
    async *streamText() {
      yield {
        type: "text-delta" as const,
        textDelta: "demo response"
      };
      yield {
        type: "done" as const,
        finishReason: "stop",
        usage: {
          inputTokens: 0,
          outputTokens: 0
        }
      };
    },
    async embed(_config: unknown, params: { values: string[] }) {
      return {
        embeddings: params.values.map(() => [0, 0, 1]),
        usage: {
          inputTokens: 0,
          outputTokens: 0
        }
      };
    },
    async generateImage(_config: unknown, params: { prompt: string }) {
      return {
        images: [
          {
            mimeType: "image/png",
            dataBase64: Buffer.from(`demo-image:${params.prompt}`).toString("base64")
          }
        ],
        usage: null
      };
    },
    async synthesizeSpeech(_config: unknown, params: { text: string; format?: string }) {
      return {
        audio: {
          mimeType: params.format ?? "audio/mpeg",
          data: Buffer.from(`demo-speech:${params.text}`)
        },
        usage: null
      };
    },
    async transcribeAudio(_config: unknown, params: { audio: { fileName?: string } }) {
      return {
        text: `demo transcription for ${params.audio.fileName ?? "audio"}`,
        usage: null
      };
    }
  };
}

export async function createRuntimeComposition(input: {
  cwd?: string;
  env?: Record<string, string | undefined>;
}) {
  const env = input.env ?? process.env;
  const cwd = input.cwd ?? process.cwd();
  const createId = createIdFactory();
  const databaseUrl = env.DATABASE_URL;
  const storagePort =
    typeof databaseUrl === "string" && databaseUrl.length > 0
      ? createPostgresStoragePort({
          connectionString: databaseUrl,
          artifactRootDirectory: resolve(cwd, "data", "artifacts")
        })
      : null;
  const repositories = storagePort
    ? await storagePort.createRepositories()
    : createInMemoryStorageRepositories();
  const presetMetadataStore = (repositories as {
    presets?: {
      save(input: PersistedPresetRecord): Promise<void>;
      patch(
        presetId: string,
        input: Partial<PersistedPresetRecord>
      ): Promise<PersistedPresetMetadata>;
      getById(id: string): Promise<PersistedPresetMetadata | null>;
      list(): Promise<PersistedPresetMetadata[]>;
    };
  }).presets;
  const pendingBlockStore = (repositories as {
    pendingBlocks?: {
      save(input: {
        blockId: string;
        sessionId: string;
        flowId: string;
        turnId: string;
        blockEnvelope?: Record<string, unknown>;
        packageName?: string;
        resumeHandler?: string;
      }): Promise<void>;
      getByBlockId(blockId: string): Promise<{
        blockId: string;
        sessionId: string;
        flowId: string;
        turnId: string;
        blockEnvelope?: Record<string, unknown>;
        packageName?: string;
        resumeHandler?: string;
      } | null>;
      delete(blockId: string): Promise<void>;
    };
  }).pendingBlocks;
  const packageRuntime = new PackageRuntime({
    packagesRoot: resolve(cwd, "extensions")
  });
  await packageRuntime.discover();
  const approvedPackageNames = new Set(resolveEnabledPackageNames(env));
  for (const pkg of packageRuntime.listPackages()) {
    if (!approvedPackageNames.has(pkg.name)) {
      continue;
    }

    await packageRuntime.enable(pkg.name);
  }

  const observability = createObservability();
  const archiveService = createArchiveService({
    repositories,
    lineageStore: createInMemoryArchiveLineageStore(),
    reindexMarkStore: createInMemoryReindexMarkStore(),
    now: () => new Date(),
    createId
  });
  const ingestionRegistry = createIngestionRegistry();

  const providerBaseUrl =
    env.LIVE_LLM_PRIMARY_BASE_URL ??
    env.OPENAI_COMPATIBLE_BASE_URL ??
    env.DASHSCOPE_BASE_URL ??
    ((env.LIVE_LLM_PRIMARY_API_KEY ?? env.DASHSCOPE_API_KEY)
      ? "https://dashscope.aliyuncs.com/compatible-mode/v1"
      : undefined);
  const providerApiKey =
    env.LIVE_LLM_PRIMARY_API_KEY ??
    env.OPENAI_COMPATIBLE_API_KEY ??
    env.DASHSCOPE_API_KEY;
  const hasProviderApiKey =
    typeof providerApiKey === "string" &&
    providerApiKey.length > 0;
  const primaryModel =
    env.LIVE_LLM_PRIMARY_MODEL ??
    env.OPENAI_COMPATIBLE_MODEL ??
    "qwen3.5-flash";
  const secondaryModel = env.LIVE_LLM_SECONDARY_MODEL;
  const baseUrl = hasProviderApiKey
    ? (providerBaseUrl ?? "https://dashscope.aliyuncs.com/compatible-mode/v1")
    : "in-memory://demo-provider";
  const apiKey = hasProviderApiKey ? providerApiKey : undefined;
  const openRouterApiKey = env.OPENROUTER_API_KEY;
  const openRouterBaseUrl = env.OPENROUTER_BASE_URL ?? "https://openrouter.ai/api/v1";
  const openRouterModel = env.OPENROUTER_MODEL;
  const openRouterHeaders =
    env.OPENROUTER_HTTP_REFERER || env.OPENROUTER_APP_NAME
      ? {
          ...(env.OPENROUTER_HTTP_REFERER ? { "HTTP-Referer": env.OPENROUTER_HTTP_REFERER } : {}),
          ...(env.OPENROUTER_APP_NAME ? { "X-Title": env.OPENROUTER_APP_NAME } : {})
        }
      : undefined;

  const runtimeProfiles: ModelProfile[] = [
    {
      id: "small",
      tier: "small",
      provider: "openaiCompatible",
      model: secondaryModel ?? primaryModel,
      contextWindow: 32_000,
      latencyClass: "low",
      costClass: "low",
      supportedModes: ["text", "object", "stream", "image", "speech", "transcription"]
    },
    {
      id: "medium",
      tier: "medium",
      provider: "openaiCompatible",
      model: primaryModel,
      contextWindow: 64_000,
      latencyClass: "medium",
      costClass: "medium",
      supportedModes: ["text", "object", "stream", "image", "speech", "transcription"]
    },
    {
      id: "large",
      tier: "large",
      provider: "openaiCompatible",
      model: primaryModel,
      contextWindow: 128_000,
      latencyClass: "high",
      costClass: "high",
      supportedModes: ["text", "object", "stream", "image", "speech", "transcription"]
    },
    {
      id: "embed-default",
      tier: "embed-default",
      provider: "openaiCompatible",
      model: env.LIVE_LLM_EMBED_MODEL ?? "text-embedding-3-small",
      contextWindow: 8_000,
      latencyClass: "low",
      costClass: "low",
      supportedModes: ["embed"]
    }
  ];

  const fallbackPresetIds: string[] = [];
  const runtimePreset: PresetMetadata = {
    id: "default-story",
    name: "Default story",
    provider: "openaiCompatible",
    model: primaryModel,
    tier: "medium",
    baseUrl,
    ...(fallbackPresetIds.length > 0 ? { fallbackPresetIds } : {}),
    supportedModes: ["text", "object", "stream", "image", "speech", "transcription"],
    enabled: true,
    isDefault: true,
    scope: "global"
  };
  const runtimePresets: Array<PersistedPresetRecord> = [
    {
      ...runtimePreset,
      apiKey
    }
  ];

  if (secondaryModel && secondaryModel !== primaryModel) {
    const secondaryPresetId = "fast-story";
    fallbackPresetIds.push(secondaryPresetId);
    runtimePresets.push({
      id: secondaryPresetId,
      name: "Fast story",
      provider: "openaiCompatible",
      model: secondaryModel,
      tier: "small",
      baseUrl,
      supportedModes: ["text", "object", "stream", "image", "speech", "transcription"],
      enabled: true,
      isDefault: false,
      scope: "global",
      apiKey
    });
  }

  if (
    typeof openRouterApiKey === "string" &&
    openRouterApiKey.length > 0 &&
    typeof openRouterModel === "string" &&
    openRouterModel.length > 0
  ) {
    const openRouterPresetId = "openrouter-story";
    fallbackPresetIds.push(openRouterPresetId);
    runtimePresets.push({
      id: openRouterPresetId,
      name: "OpenRouter story",
      provider: "openrouter",
      model: openRouterModel,
      tier: "small",
      baseUrl: openRouterBaseUrl,
      supportedModes: ["text", "object", "stream", "image", "speech", "transcription"],
      enabled: true,
      isDefault: false,
      scope: "global",
      apiKey: openRouterApiKey
    });
  }

  if (fallbackPresetIds.length > 0) {
    runtimePreset.fallbackPresetIds = [...fallbackPresetIds];
    runtimePresets[0] = {
      ...runtimePresets[0],
      fallbackPresetIds: [...fallbackPresetIds]
    };
  }
  const persistedPresets =
    storagePort && presetMetadataStore ? await presetMetadataStore.list() : [];

  if (presetMetadataStore && persistedPresets.length === 0) {
    for (const preset of runtimePresets) {
      await presetMetadataStore.save(preset);
    }
  }

  const providerRegistry = createProviderRegistry({
    providers: {
      openaiCompatible: {
        adapter: baseUrl === "in-memory://demo-provider" ? createDemoAdapter() : undefined,
        defaults: {
          baseUrl,
          apiKey
        }
      },
      ...(openRouterApiKey
        ? {
            openrouter: {
              defaults: {
                baseUrl: openRouterBaseUrl,
                apiKey: openRouterApiKey,
                ...(openRouterHeaders ? { headers: openRouterHeaders } : {})
              }
            }
          }
        : {})
    }
  });
  const profileRegistry = createModelProfileRegistry({
    runtimeProfiles,
    runtimePresets: runtimePresets.map(({ apiKey: _apiKey, ...preset }) => preset),
    persistedPresets
  });
  const modelGateway = createModelGateway({
    providerRegistry,
    profileRegistry
  });

  const commandRegistry = new CommandRegistry();
  function buildPackageExecutionContext(
    packageName: string,
    context: {
      sessionId?: string;
      locale?: SupportedLocale;
      requestId?: string;
      flowId?: string;
      turnId?: string;
      block?: unknown;
      response?: unknown;
    }
  ) {
    const manifestPermissions = new Set(
      packageRuntime.getPackage(packageName)?.manifest.permissions ?? []
    );

    return {
      ...context,
      ...(manifestPermissions.has("read:archive") ? { archiveService } : {}),
      ...(manifestPermissions.has("read:packages") ? { packageRuntime } : {}),
      ...(manifestPermissions.has("read:preset") ? { runtimePreset } : {}),
      ...(manifestPermissions.has("read:memory") ? { ingestionRegistry } : {}),
      ...(manifestPermissions.has("write:observability") ? { observability } : {}),
      ...(manifestPermissions.has("invoke:model") ? { modelGateway } : {})
    };
  }
  for (const registeredCommand of packageRuntime.listCommands()) {
    commandRegistry.register(
      createSlashCommandSpec({
        name: registeredCommand.name,
        description: registeredCommand.description,
        handler: registeredCommand.entry,
        resume: registeredCommand.resume,
        argsSchema: registeredCommand.argsSchema,
        execute: async (args, context) =>
          registeredCommand.execute(
            args,
            buildPackageExecutionContext(registeredCommand.packageName, {
              sessionId: context.sessionId as string | undefined,
              locale: context.locale as SupportedLocale | undefined
            })
          ),
        help: registeredCommand.help,
        autocomplete: registeredCommand.autocomplete
      })
    );
  }

  commandRegistry.register(
    createSlashCommandSpec({
      name: "help",
      description: "List available commands",
      handler: "runtime/help",
      resume: false,
      argsSchema: {
        safeParse() {
          return { success: true, data: {} } as const;
        }
      } as any,
      async execute(_args, context: { locale?: SupportedLocale }) {
        const locale = context.locale ?? DEFAULT_LOCALE;
        return {
          content: commandRegistry
            .listHelp()
            .map((entry) => ({
              ...entry,
              description: translateCommandDescription(entry.name, entry.description, locale)
            }))
            .map((entry) => `${entry.usage ?? `/${entry.name}`} - ${entry.description}`)
            .join("\n")
        };
      },
      help: {
        usage: "/help"
      }
    })
  );

  const commandBus = new CommandBus({
    registry: commandRegistry
  });

  const flowEngine = new FlowEngine({
    sessions: repositories.sessions,
    messages: repositories.messages,
    pendingBlockStore,
    modelGateway: {
      async generateText(input: {
        sessionId: string;
        prompt: string;
        requestId: string;
        flowId: string;
        locale: SupportedLocale;
      }) {
        const session = await repositories.sessions.getById(input.sessionId);
        const activePresetId = session?.taskBindings?.[STORY_NARRATION_TASK] ?? session?.presetId ?? runtimePreset.id;
        const activeTarget = profileRegistry.resolveTextTarget({
          presetId: activePresetId
        });
        const activeModel = activeTarget.preset?.model ?? activeTarget.profile.model;
        const result = await modelGateway.generateText({
          presetId: activePresetId,
          messages: [
            {
              role: "system",
              content: createLocaleSystemInstruction(input.locale)
            },
            {
              role: "user",
              content: input.prompt
            }
          ]
        });

        observability.recordTrace({
          traceId: `trace_${input.requestId}`,
          spanId: createId("span"),
          sessionId: input.sessionId,
          turnId: input.flowId,
          component: "model-gateway",
          eventType: "model.completed",
          payload: {
            model: activeModel
          },
          createdAt: new Date().toISOString()
        });
        await repositories.traceRecords.save({
          traceId: `trace_${input.requestId}`,
          spanId: createId("span"),
          sessionId: input.sessionId,
          turnId: input.flowId,
          component: "model-gateway",
          eventType: "model.completed",
          payload: {
            model: activeModel
          },
          createdAt: new Date()
        });

        return {
          content: result.text,
          traceId: `trace_${input.requestId}`
        };
      }
    },
    commandBus: {
      async execute(input: {
        commandText: string;
        sessionId: string;
        requestId: string;
        locale: SupportedLocale;
      }) {
        const result = await commandBus.dispatch(input.commandText, {
          sessionId: input.sessionId,
          locale: input.locale
        }) as {
          content?: string;
          blocks?: any[];
        };

        return {
          ...result,
          traceId: `trace_${input.requestId}`
        };
      }
    },
    resumeExecutor: {
      async execute(input: {
        handler: string;
        block: {
          meta: {
            package: string;
          };
        };
        response: unknown;
        sessionId: string;
        requestId: string;
        flowId: string;
        turnId: string;
        locale: SupportedLocale;
      }) {
        const packageName = input.block.meta.package;
        const capability = packageRuntime.getCapability(input.handler);
        if (capability && capability.packageName === packageName) {
          const result = await capability.execute(
            {
              block: input.block,
              response: input.response,
              requestId: input.requestId,
              flowId: input.flowId,
              turnId: input.turnId
            },
            buildPackageExecutionContext(packageName, {
              sessionId: input.sessionId,
              locale: input.locale,
              requestId: input.requestId,
              flowId: input.flowId,
              turnId: input.turnId,
              block: input.block,
              response: input.response
            })
          ) as {
            content?: string;
            blocks?: any[];
          };

          return {
            ...result,
            traceId: `trace_${input.requestId}`
          };
        }

        const hook = packageRuntime.getHook(input.handler);
        if (hook && hook.packageName === packageName) {
          const result = await hook.execute(
            {
              block: input.block,
              response: input.response,
              requestId: input.requestId,
              flowId: input.flowId,
              turnId: input.turnId
            },
            buildPackageExecutionContext(packageName, {
              sessionId: input.sessionId,
              locale: input.locale,
              requestId: input.requestId,
              flowId: input.flowId,
              turnId: input.turnId,
              block: input.block,
              response: input.response
            })
          ) as {
            content?: string;
            blocks?: any[];
          };

          return {
            ...result,
            traceId: `trace_${input.requestId}`
          };
        }

        throw new Error(
          `Resume handler '${input.handler}' was not found for package '${packageName}'.`
        );
      }
    },
    createId,
    now: () => new Date()
  } as any);

  return {
    repositories,
    packageRuntime,
    commandRegistry,
    commandBus,
    providerRegistry,
    profileRegistry,
    presetMetadataStore,
    archiveService,
    observability,
    modelGateway,
    runtimePreset,
    flowEngine
  };
}

function resolveEnabledPackageNames(env: Record<string, string | undefined>): string[] {
  const configured = env.COVEL_ENABLED_PACKAGES
    ?.split(",")
    .map((name) => name.trim())
    .filter((name) => name.length > 0);

  return configured && configured.length > 0
    ? configured
    : [...DEFAULT_ENABLED_PACKAGE_NAMES];
}
