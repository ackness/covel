import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { z } from "zod";

import { createArchiveService, createInMemoryArchiveLineageStore, createInMemoryReindexMarkStore } from "../../../modules/archive/src/index.js";
import { CommandBus, CommandRegistry, createSlashCommandSpec } from "../../../modules/command-system/src/index.js";
import { createContextGraph } from "../../../modules/context-graph/src/index.js";
import { FlowEngine } from "../../../modules/flow-engine/src/index.js";
import { createIngestionRegistry, retrieveEntityAware } from "../../../modules/memory-rag/src/index.js";
import {
  createModelGateway,
  createModelProfileRegistry,
  createProviderRegistry,
  ModelGatewayError,
  type ModelProfile,
  type PresetMetadata
} from "../../../modules/model-gateway/src/index.js";
import { createObservability } from "../../../modules/observability/src/index.js";
import {
  PackageRuntime,
  type PackageContextFragment,
  type PackageContextProviderExecutionContext,
  type PackageContextRepositories
} from "../../../modules/package-runtime/src/index.js";
import { parseJsonSchema, validateJsonSchemaValue, type JsonSchemaNode } from "../../../modules/package-runtime/src/index.js";
import { compilePromptGraph } from "../../../modules/prompt-graph/src/index.js";
import { createInMemoryStorageRepositories, createPostgresStoragePort } from "../../../modules/storage/src/index.js";
import { DEFAULT_LOCALE, type SupportedLocale } from "../../../modules/contracts/src/index.js";
import {
  type DomainRepositories,
  STORY_NARRATION_TASK,
  createRetrievalRun,
  type PackageStateRepository,
  type Session,
  type World
} from "../../../modules/domain/src/index.js";
import type { PersistedPresetMetadata, PersistedPresetRecord } from "../../../modules/storage/src/index.js";
import { buildRuntimePresetBootstrap } from "./default-presets.js";
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
const DEFAULT_PACKAGE_CONTEXT_MAX_TOKENS = 1_200;

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
    async generateObject(_config: unknown, params: {
      schema: {
        safeParse?(value: unknown): { success: boolean; data?: unknown };
        parse(value: unknown): unknown;
      };
      messages?: Array<{
        role?: string;
        content?: string;
      }>;
    }) {
      const lastUserMessage = [...(params.messages ?? [])]
        .reverse()
        .find((message) => message.role === "user");
      const prompt = String(lastUserMessage?.content ?? "");
      const wantsChoice = /choice|choose|option|select|选择|选项|抉择/.test(prompt);
      const isEnglish = /\b(choose|choice|option|select)\b/i.test(prompt);
      const candidates = [
        {
          content: wantsChoice
            ? isEnglish
              ? "The in-memory guide pauses and offers the next move."
              : "内存内导游停顿了一下，并给出了下一步选项。"
            : "demo response from the in-memory provider",
          blocks: wantsChoice
            ? [
                {
                  type: "choice_set",
                  data: {
                    title: isEnglish ? "Choose the next move" : "选择下一步行动",
                    options: [
                      {
                        id: "opt_a",
                        label: isEnglish ? "Advance" : "继续前进"
                      },
                      {
                        id: "opt_b",
                        label: isEnglish ? "Observe" : "观察周围"
                      }
                    ]
                  }
                }
              ]
            : []
        },
        {
          title: "demo",
          mood: "calm"
        }
      ];

      for (const candidate of candidates) {
        if (typeof params.schema.safeParse === "function") {
          const validation = params.schema.safeParse(candidate);
          if (validation.success) {
            return {
              object: validation.data,
              finishReason: "stop",
              usage: {
                inputTokens: 0,
                outputTokens: 0
              }
            };
          }
        } else {
          try {
            return {
              object: params.schema.parse(candidate),
              finishReason: "stop",
              usage: {
                inputTokens: 0,
                outputTokens: 0
              }
            };
          } catch {
            // Try the next candidate.
          }
        }
      }

      return {
        object: params.schema.parse(candidates[0]),
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

const ChoiceOptionSchema = z.object({
  id: z.string().trim().min(1),
  label: z.string().trim().min(1)
});

const ModelChoiceSetBlockSchema = z.object({
  type: z.enum(["choice_set", "choices"]),
  data: z.object({
    title: z.string().trim().min(1),
    options: z.array(ChoiceOptionSchema).min(1).max(6)
  })
});

const ModelDiceResultBlockSchema = z.object({
  type: z.literal("dice_result"),
  data: z.object({
    title: z.string().trim().min(1).optional(),
    formula: z.string().trim().min(1).optional(),
    roll: z.union([z.number(), z.string()]).optional(),
    total: z.union([z.number(), z.string()]).optional(),
    outcome: z.string().trim().min(1).optional(),
    detail: z.string().trim().min(1).optional()
  })
});

const ModelImageCardBlockSchema = z.object({
  type: z.literal("image_card"),
  data: z.object({
    title: z.string().trim().min(1).optional(),
    imageUrl: z.string().trim().min(1).optional(),
    alt: z.string().trim().min(1).optional(),
    caption: z.string().trim().min(1).optional()
  })
});

const ModelAudioClipBlockSchema = z.object({
  type: z.literal("audio_clip"),
  data: z.object({
    title: z.string().trim().min(1).optional(),
    audioUrl: z.string().trim().min(1).optional(),
    transcript: z.string().trim().min(1).optional()
  })
});

const ModelNarrationBlockSchema = z.union([
  ModelChoiceSetBlockSchema,
  ModelDiceResultBlockSchema,
  ModelImageCardBlockSchema,
  ModelAudioClipBlockSchema
]);

const ModelNarrationTurnSchema = z.object({
  content: z.string().trim().min(1),
  blocks: z.array(ModelNarrationBlockSchema).max(4).optional().default([])
});

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

  const blockSchemaCache = new Map<string, JsonSchemaNode>();
  async function loadBlockSchema(schemaPath: string) {
    const cached = blockSchemaCache.get(schemaPath);
    if (cached) {
      return cached;
    }

    const schema = parseJsonSchema(await readFile(schemaPath, "utf8"), schemaPath);
    blockSchemaCache.set(schemaPath, schema);
    return schema;
  }

  const blockValidator = {
    async validateData(block: {
      type: string;
      meta: {
        package: string;
      };
      data: unknown;
    }) {
      const registeredBlock = packageRuntime.getBlock(block.type);
      if (!registeredBlock) {
        return { ok: true } as const;
      }

      if (registeredBlock.packageName !== block.meta.package) {
        return {
          ok: false,
          code: "BLOCK_DATA_SCHEMA_INVALID" as const,
          details: `Registered package '${registeredBlock.packageName}' does not match block package '${block.meta.package}'.`
        };
      }

      const validation = validateJsonSchemaValue(
        await loadBlockSchema(registeredBlock.dataSchemaPath),
        block.data
      );
      return validation.ok
        ? { ok: true as const }
        : {
            ok: false as const,
            code: "BLOCK_DATA_SCHEMA_INVALID" as const,
            details: validation.error
          };
    },
    async validateResponse(
      block: {
        type: string;
        meta: {
          package: string;
        };
      },
      response: {
        blockType: string;
        response: unknown;
      }
    ) {
      if (response.blockType !== block.type) {
        return {
          ok: false as const,
          code: "BLOCK_RESPONSE_SCHEMA_INVALID" as const,
          details: `Response block type '${response.blockType}' does not match pending block type '${block.type}'.`
        };
      }

      const registeredBlock = packageRuntime.getBlock(block.type);
      if (!registeredBlock) {
        return { ok: true as const };
      }

      if (registeredBlock.packageName !== block.meta.package) {
        return {
          ok: false as const,
          code: "BLOCK_RESPONSE_SCHEMA_INVALID" as const,
          details: `Registered package '${registeredBlock.packageName}' does not match block package '${block.meta.package}'.`
        };
      }

      const validation = validateJsonSchemaValue(
        await loadBlockSchema(registeredBlock.responseSchemaPath),
        response.response
      );
      return validation.ok
        ? { ok: true as const }
        : {
            ok: false as const,
            code: "BLOCK_RESPONSE_SCHEMA_INVALID" as const,
            details: validation.error
          };
    }
  };

  const observability = createObservability();
  const archiveService = createArchiveService({
    repositories,
    lineageStore: createInMemoryArchiveLineageStore(),
    reindexMarkStore: createInMemoryReindexMarkStore(),
    now: () => new Date(),
    createId
  });
  const ingestionRegistry = createIngestionRegistry();

  const {
    primaryModel,
    providerBaseUrl: baseUrl,
    providerApiKey: apiKey,
    runtimePreset,
    runtimePresets
  } = buildRuntimePresetBootstrap({
    env
  });
  const secondaryModel = env.LIVE_LLM_SECONDARY_MODEL;
  const openRouterApiKey = env.OPENROUTER_API_KEY;
  const openRouterBaseUrl = env.OPENROUTER_BASE_URL ?? "https://openrouter.ai/api/v1";
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
  const repositoriesWithPackageState = repositories as typeof repositories & {
    packageState?: PackageStateRepository;
  };
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
      ...(manifestPermissions.has("invoke:model") ? { modelGateway } : {}),
      repositories: {
        ...(manifestPermissions.has("read:world") ? { worlds: repositories.worlds } : {}),
        ...(manifestPermissions.has("read:session")
          ? {
              sessions: repositories.sessions,
              messages: repositories.messages,
              artifacts: repositories.artifacts
            }
          : {}),
        ...(manifestPermissions.has("read:memory")
          ? {
              memoryDocuments: repositories.memoryDocuments
            }
          : {}),
        ...(repositoriesWithPackageState.packageState
          ? {
              packageState: repositoriesWithPackageState.packageState
            }
          : {})
      }
    };
  }

  function buildPackageContextExecutionContext(
    packageName: string,
    context: {
      locale: SupportedLocale;
      session: Session | null;
      world: World | null;
    }
  ): PackageContextProviderExecutionContext {
    const manifestPermissions = new Set(
      packageRuntime.getPackage(packageName)?.manifest.permissions ?? []
    );
    const providerRepositories: PackageContextRepositories = {
      ...(manifestPermissions.has("read:world") ? { worlds: repositories.worlds } : {}),
      ...(manifestPermissions.has("read:session")
        ? {
            sessions: repositories.sessions,
            messages: repositories.messages,
            artifacts: repositories.artifacts
          }
        : {}),
      ...(manifestPermissions.has("read:memory")
        ? {
            memoryDocuments: repositories.memoryDocuments
          }
        : {}),
      ...(repositoriesWithPackageState.packageState
        ? {
            packageState: repositoriesWithPackageState.packageState
          }
        : {})
    };

    return {
      locale: context.locale,
      ...(manifestPermissions.has("read:world") ? { world: context.world } : {}),
      ...(manifestPermissions.has("read:session") ? { session: context.session } : {}),
      ...(Object.keys(providerRepositories).length > 0 ? { repositories: providerRepositories } : {}),
      ...(manifestPermissions.has("read:memory") ? { ingestionRegistry } : {}),
      ...(manifestPermissions.has("read:preset") ? { runtimePreset } : {})
    };
  }

  async function buildTurnContextMessages(input: {
    requestId: string;
    turnId: string;
    session: Session;
    prompt: string;
    locale: SupportedLocale;
  }): Promise<Array<{ role: "system"; content: string }>> {
    const world = await repositories.worlds.getById(input.session.worldId);
    const fragments: Array<PackageContextFragment & { packageName: string }> = [];

    for (const provider of packageRuntime.listContextProviders()) {
      try {
        const nextFragments = await provider.build(
          {
            sessionId: input.session.id,
            worldId: input.session.worldId,
            prompt: input.prompt,
            locale: input.locale
          },
          buildPackageContextExecutionContext(provider.packageName, {
            locale: input.locale,
            session: input.session,
            world
          })
        );

        fragments.push(...normalizePackageContextFragments(provider.packageName, nextFragments));
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const traceEntry = {
          traceId: `trace_${input.requestId}`,
          spanId: createId("span"),
          sessionId: input.session.id,
          turnId: input.turnId,
          component: "package-context",
          eventType: "provider.failed",
          payload: {
            packageName: provider.packageName,
            providerId: provider.id,
            message
          },
          createdAt: new Date().toISOString()
        };

        observability.recordTrace(traceEntry);
        await repositories.traceRecords.save({
          ...traceEntry,
          createdAt: new Date(traceEntry.createdAt)
        });
      }
    }

    const retrievalFragments = await buildRetrievalContextFragments({
      repositories,
      session: input.session,
      world,
      prompt: input.prompt,
      requestId: input.requestId,
      turnId: input.turnId,
      locale: input.locale
    });
    fragments.push(...retrievalFragments);

    if (fragments.length === 0) {
      return [];
    }

    const promptGraph = compilePromptGraph({
      contextGraph: createContextGraph({
        nodes: fragments.map((fragment) => toContextNode(fragment, input.locale))
      }),
      maxTokens: DEFAULT_PACKAGE_CONTEXT_MAX_TOKENS
    });

    const traceEntry = {
      traceId: `trace_${input.requestId}`,
      spanId: createId("span"),
      sessionId: input.session.id,
      turnId: input.turnId,
      component: "package-context",
      eventType: "context.assembled",
      payload: {
        fragmentCount: fragments.length,
        selectedNodeCount: promptGraph.nodes.length,
        totalTokenCost: promptGraph.totalTokenCost,
        packages: Array.from(new Set(fragments.map((fragment) => fragment.packageName))).sort()
      },
      createdAt: new Date().toISOString()
    };

    observability.recordTrace(traceEntry);
    await repositories.traceRecords.save({
      ...traceEntry,
      createdAt: new Date(traceEntry.createdAt)
    });

    return promptGraph.nodes.map((node) => ({
      role: "system" as const,
      content: node.content
    }));
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
          content: [
            locale === "en" ? "## Available Commands" : "## 可用命令",
            "",
            ...commandRegistry
              .listHelp()
              .map((entry) => ({
                ...entry,
                description: translateCommandDescription(entry.name, entry.description, locale)
              }))
              .map((entry) => `- \`${entry.usage ?? `/${entry.name}`}\` - ${entry.description}`)
          ].join("\n")
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
    blockValidator,
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
        const packageContextMessages = session
          ? await buildTurnContextMessages({
              requestId: input.requestId,
              turnId: input.flowId,
              session,
              prompt: input.prompt,
              locale: input.locale
            })
          : [];
        const narrationMessages = [
          {
            role: "system" as const,
            content: createLocaleSystemInstruction(input.locale)
          },
          {
            role: "system" as const,
            content: createNarrationBlockInstruction(input.locale)
          },
          ...packageContextMessages,
          {
            role: "user" as const,
            content: input.prompt
          }
        ];
        const result = await (async () => {
          try {
            const structured = await modelGateway.generateObject({
              presetId: activePresetId,
              schema: ModelNarrationTurnSchema,
              messages: narrationMessages
            });

            return {
              content: structured.object.content,
              blocks: structured.object.blocks.map((block) => toRuntimeBlockEnvelope(block, input))
            };
          } catch (error) {
            if (!(error instanceof ModelGatewayError) || error.code !== "PROVIDER_ERROR") {
              throw error;
            }

            const fallback = await modelGateway.generateText({
              presetId: activePresetId,
              messages: [
                {
                  role: "system" as const,
                  content: createLocaleSystemInstruction(input.locale)
                },
                {
                  role: "system" as const,
                  content: createPlainNarrationFallbackInstruction(input.locale)
                },
                ...packageContextMessages,
                {
                  role: "user" as const,
                  content: input.prompt
                }
              ]
            });

            return {
              content: fallback.text,
              blocks: [] as Array<ReturnType<typeof toRuntimeBlockEnvelope>>
            };
          }
        })();

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
          content: result.content,
          blocks: result.blocks,
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

async function buildRetrievalContextFragments(input: {
  repositories: DomainRepositories;
  session: Session;
  world: World | null;
  prompt: string;
  requestId: string;
  turnId: string;
  locale: SupportedLocale;
}): Promise<Array<PackageContextFragment & { packageName: string }>> {
  const docs = [
    ...(await inputSessionAndWorldMemoryDocs(input.session.id, input.world?.id))
  ];

  if (docs.length === 0) {
    return [];
  }

  const retrieval = await retrieveEntityAware({
    query: input.prompt,
    documents: docs
  });

  const selectedChunks = [
    ...retrieval.candidates.slice(0, 3),
    ...retrieval.expanded.slice(0, 2)
  ];

  if (selectedChunks.length === 0) {
    return [];
  }

  await input.repositories.retrievalRuns.save(createRetrievalRun({
    id: `retrieval_${input.requestId}`,
    sessionId: input.session.id,
    query: input.prompt,
    rewrittenQueries: [input.prompt],
    selectedSources: Array.from(new Set(selectedChunks.map((chunk) => chunk.sourceType))),
    candidates: retrieval.candidates.map((chunk) => chunk.chunkId),
    selectedChunks: selectedChunks.map((chunk) => chunk.chunkId),
    critique: retrieval.expanded.length > 0
      ? "entity-aware expansion applied"
      : "hybrid retrieval only",
    latencyMs: 0
  }));

  return [
    {
      packageName: "runtime-retrieval",
      id: `retrieval:${input.requestId}`,
      title: input.locale === "en" ? "Retrieved memory" : "检索上下文",
      content: selectedChunks
        .map((chunk) => `## ${chunk.sourceType} / ${chunk.scope}\n${truncateText(chunk.text, 260)}`)
        .join("\n\n"),
      priority: 82,
      channel: "memory",
      tokenCost: selectedChunks.reduce((sum, chunk) => sum + estimateContextTokenCost({
        id: chunk.chunkId,
        title: chunk.scope,
        content: chunk.text,
        priority: 0
      }), 0)
    }
  ];

  async function inputSessionAndWorldMemoryDocs(sessionId: string, worldId?: string) {
    return [
      ...(await input.repositories.memoryDocuments.listByScope(`session:${sessionId}`)),
      ...(worldId ? await input.repositories.memoryDocuments.listByScope(`world:${worldId}`) : [])
    ];
  }
}

function normalizePackageContextFragments(
  packageName: string,
  input: PackageContextFragment[] | null | undefined
): Array<PackageContextFragment & { packageName: string }> {
  return (input ?? [])
    .filter((fragment) =>
      fragment &&
      typeof fragment.id === "string" &&
      fragment.id.trim().length > 0 &&
      typeof fragment.title === "string" &&
      fragment.title.trim().length > 0 &&
      typeof fragment.content === "string" &&
      fragment.content.trim().length > 0 &&
      typeof fragment.priority === "number"
    )
    .map((fragment) => ({
      ...fragment,
      packageName,
      id: fragment.id.trim(),
      title: fragment.title.trim(),
      content: fragment.content.trim()
    }));
}

function toContextNode(
  fragment: PackageContextFragment & { packageName: string },
  locale: SupportedLocale
) {
  return {
    id: `${fragment.packageName}:${fragment.id}`,
    source: fragment.packageName,
    priority: fragment.priority,
    tokenCost: fragment.tokenCost ?? estimateContextTokenCost(fragment),
    pinned: fragment.pinned ?? fragment.channel === "instruction",
    content: renderContextFragment(fragment, locale),
    provenance: {
      packageName: fragment.packageName,
      channel: fragment.channel ?? "reference",
      fragmentId: fragment.id
    }
  };
}

function renderContextFragment(
  fragment: PackageContextFragment & { packageName: string },
  locale: SupportedLocale
): string {
  const channel = fragment.channel ?? "reference";
  const channelLabel = locale === "en"
    ? {
        instruction: "instruction",
        memory: "memory",
        state: "state",
        reference: "reference"
      }[channel]
    : {
        instruction: "指令",
        memory: "记忆",
        state: "状态",
        reference: "参考"
      }[channel];

  return locale === "en"
    ? [
        `Package context from ${fragment.packageName} / ${fragment.title} (${channelLabel}):`,
        fragment.content
      ].join("\n")
    : [
        `来自扩展 ${fragment.packageName} 的${channelLabel}上下文：${fragment.title}`,
        fragment.content
      ].join("\n");
}

function estimateContextTokenCost(fragment: PackageContextFragment): number {
  return Math.max(40, Math.ceil((fragment.title.length + fragment.content.length) / 4));
}

function truncateText(value: string, maxLength: number): string {
  return value.length > maxLength
    ? `${value.slice(0, maxLength).trimEnd()}…`
    : value;
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

function createNarrationBlockInstruction(locale: SupportedLocale): string {
  return locale === "en"
    ? [
        "Return a structured narration object with `content` and optional `blocks`.",
        "Available block types:",
        "- `choice_set`: interactive choices with `data.title` and `data.options[{id,label}]`.",
        "- `dice_result`: structured dice outcomes with `data.formula`, `data.total`, and optional details.",
        "- `image_card`: an image callout with `data.imageUrl`, optional title/caption.",
        "- `audio_clip`: an audio callout with `data.audioUrl` and optional transcript.",
        "Use blocks only when they clearly improve the turn. Prefer `choice_set` when the player should decide the next move."
      ].join(" ")
    : [
        "请返回结构化叙事对象，包含 `content`，并可选包含 `blocks`。",
        "可用 block 类型：",
        "- `choice_set`：交互选项，包含 `data.title` 和 `data.options[{id,label}]`。",
        "- `dice_result`：结构化判定结果，包含 `data.formula`、`data.total` 以及可选说明。",
        "- `image_card`：图片展示块，包含 `data.imageUrl`，可选标题与说明。",
        "- `audio_clip`：音频展示块，包含 `data.audioUrl`，可选转录文本。",
        "只有在能明显提升当前回合表达时才使用 block；当需要玩家决定下一步行动时优先使用 `choice_set`。"
      ].join(" ");
}

function createPlainNarrationFallbackInstruction(locale: SupportedLocale): string {
  return locale === "en"
    ? [
        "The structured-output route is unavailable for this turn.",
        "Return plain narrative prose only.",
        "Do not return JSON, code fences, field labels such as `content:` or `blocks:`, or any schema-shaped output."
      ].join(" ")
    : [
        "本回合的结构化输出通道不可用。",
        "请只返回自然叙事正文。",
        "不要返回 JSON、代码块、`content:`、`blocks:` 这类字段标签，也不要模拟 schema 结构。"
      ].join(" ");
}

function toRuntimeBlockEnvelope(
  block: z.infer<typeof ModelNarrationBlockSchema>,
  input: {
    sessionId: string;
    requestId: string;
    flowId: string;
  }
) {
  const base = {
    id: "draft_block",
    version: "1.0",
    meta: {
      package: "runtime",
      requestId: input.requestId,
      traceId: `trace_${input.requestId}`,
      sessionId: input.sessionId,
      turnId: input.flowId
    }
  };

  if (block.type === "choice_set" || block.type === "choices") {
    return {
      ...base,
      type: "choice_set",
      interaction: {
        requiresResponse: true,
        responseSchema: "runtime://choice_set.response",
        submitAs: "block_response",
        resumePolicy: "resume_current_flow"
      },
      data: block.data
    };
  }

  return {
    ...base,
    type: block.type,
    interaction: {
      requiresResponse: false
    },
    data: block.data
  };
}
