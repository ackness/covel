import { resolve } from "node:path";

import { createArchiveService, createInMemoryArchiveLineageStore, createInMemoryReindexMarkStore } from "../../../modules/archive/src/index.js";
import { CommandBus, CommandRegistry, createSlashCommandSpec } from "../../../modules/command-system/src/index.js";
import { FlowEngine } from "../../../modules/flow-engine/src/index.js";
import { createIngestionRegistry } from "../../../modules/memory-rag/src/index.js";
import { createModelGateway, createModelProfileRegistry, createProviderRegistry, type ModelProfile, type PresetMetadata } from "../../../modules/model-gateway/src/index.js";
import { createObservability } from "../../../modules/observability/src/index.js";
import { PackageRuntime } from "../../../modules/package-runtime/src/index.js";
import { createInMemoryStorageRepositories, createPostgresStoragePort } from "../../../modules/storage/src/index.js";

function createIdFactory() {
  let counter = 1;
  return (kind: string) => `${kind}_${counter++}`;
}

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
  const packageRuntime = new PackageRuntime({
    packagesRoot: resolve(cwd, "extensions")
  });
  await packageRuntime.discover();
  for (const pkg of packageRuntime.listPackages()) {
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
    env.DASHSCOPE_BASE_URL;
  const providerApiKey =
    env.LIVE_LLM_PRIMARY_API_KEY ??
    env.OPENAI_COMPATIBLE_API_KEY ??
    env.DASHSCOPE_API_KEY;
  const shouldUseRealProvider =
    typeof providerBaseUrl === "string" &&
    providerBaseUrl.length > 0 &&
    typeof providerApiKey === "string" &&
    providerApiKey.length > 0;
  const primaryModel =
    env.LIVE_LLM_PRIMARY_MODEL ??
    env.OPENAI_COMPATIBLE_MODEL ??
    "qwen3.5-flash";
  const baseUrl = shouldUseRealProvider
    ? providerBaseUrl
    : "in-memory://demo-provider";
  const apiKey = shouldUseRealProvider ? providerApiKey : undefined;

  const runtimeProfiles: ModelProfile[] = [
    {
      id: "small",
      tier: "small",
      provider: "openaiCompatible",
      model: env.LIVE_LLM_SECONDARY_MODEL ?? primaryModel,
      contextWindow: 32_000,
      latencyClass: "low",
      costClass: "low",
      supportedModes: ["text", "object", "stream"]
    },
    {
      id: "medium",
      tier: "medium",
      provider: "openaiCompatible",
      model: primaryModel,
      contextWindow: 64_000,
      latencyClass: "medium",
      costClass: "medium",
      supportedModes: ["text", "object", "stream"]
    },
    {
      id: "large",
      tier: "large",
      provider: "openaiCompatible",
      model: primaryModel,
      contextWindow: 128_000,
      latencyClass: "high",
      costClass: "high",
      supportedModes: ["text", "object", "stream"]
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

  const runtimePreset: PresetMetadata = {
    id: "default-story",
    name: "Default story",
    provider: "openaiCompatible",
    model: primaryModel,
    tier: "medium",
    baseUrl,
    supportedModes: ["text", "object", "stream"],
    enabled: true,
    isDefault: true,
    scope: "global"
  };

  const providerRegistry = createProviderRegistry({
    providers: {
      openaiCompatible: {
        adapter: baseUrl === "in-memory://demo-provider" ? createDemoAdapter() : undefined,
        defaults: {
          baseUrl,
          apiKey
        }
      }
    }
  });
  const profileRegistry = createModelProfileRegistry({
    runtimeProfiles,
    runtimePresets: [runtimePreset]
  });
  const modelGateway = createModelGateway({
    providerRegistry,
    profileRegistry
  });

  const commandRegistry = new CommandRegistry();
  commandRegistry.register(createSlashCommandSpec({
    name: "guide",
    description: "Generate a guide block",
    handler: "runtime/guide",
    resume: false,
    argsSchema: {
      safeParse(value: unknown) {
        return { success: true, data: value ?? {} } as const;
      }
    } as any,
    async execute() {
      return {
        content: "Guide generated.",
        blocks: [
          {
            id: "blk_guide",
            type: "choices",
            version: "1.0",
            meta: {
              package: "core-guide",
              requestId: "req_guide",
              traceId: "tr_guide",
              sessionId: "ses_guide",
              turnId: "turn_guide"
            },
            interaction: {
              requiresResponse: true,
              responseSchema: "schemas/blocks/choices.response.json",
              submitAs: "block_response",
              resumePolicy: "resume_current_flow"
            },
            data: {
              title: "Next step",
              options: [
                { id: "opt_a", label: "Continue" },
                { id: "opt_b", label: "Observe" }
              ]
            }
          }
        ]
      };
    },
    help: {
      usage: "/guide"
    }
  }));
  commandRegistry.register(createSlashCommandSpec({
    name: "archive",
    description: "Create an archive snapshot",
    handler: "runtime/archive",
    resume: false,
    argsSchema: {
      safeParse() {
        return { success: true, data: {} } as const;
      }
    } as any,
    async execute(_args, context) {
      const sessionId = String((context as Record<string, unknown>).sessionId ?? "");
      if (!sessionId) {
        return {
          content: "No active session."
        };
      }
      const snapshot = await archiveService.createSnapshot({
        sessionId,
        turnCutoff: 0,
        stateSnapshot: {},
        workingSummary: "Working summary",
        archiveSummary: "Archive summary"
      });
      return {
        content: `Archive ${snapshot.version.id} created.`
      };
    },
    help: { usage: "/archive" }
  }));
  commandRegistry.register(createSlashCommandSpec({
    name: "packages",
    description: "List enabled packages",
    handler: "runtime/packages",
    resume: false,
    argsSchema: { safeParse() { return { success: true, data: {} } as const; } } as any,
    async execute() {
      return {
        content: packageRuntime.listPackages().filter((pkg) => pkg.enabled).map((pkg) => pkg.name).join(", ")
      };
    },
    help: { usage: "/packages" }
  }));
  commandRegistry.register(createSlashCommandSpec({
    name: "trace",
    description: "Inspect trace state",
    handler: "runtime/trace",
    resume: false,
    argsSchema: { safeParse() { return { success: true, data: {} } as const; } } as any,
    async execute() {
      return {
        content: "Trace inspection available."
      };
    },
    help: { usage: "/trace" }
  }));
  commandRegistry.register(createSlashCommandSpec({
    name: "memory",
    description: "Inspect memory state",
    handler: "runtime/memory",
    resume: false,
    argsSchema: { safeParse() { return { success: true, data: {} } as const; } } as any,
    async execute() {
      return {
        content: `Ingestion registry size: ${ingestionRegistry.get("world:world_01") ? 1 : 0}`
      };
    },
    help: { usage: "/memory" }
  }));
  commandRegistry.register(createSlashCommandSpec({
    name: "presets",
    description: "Inspect active preset state",
    handler: "runtime/presets",
    resume: false,
    argsSchema: { safeParse() { return { success: true, data: {} } as const; } } as any,
    async execute() {
      return {
        content: runtimePreset.id
      };
    },
    help: { usage: "/presets" }
  }));
  commandRegistry.register(createSlashCommandSpec({
    name: "session",
    description: "Inspect current session state",
    handler: "runtime/session",
    resume: false,
    argsSchema: { safeParse() { return { success: true, data: {} } as const; } } as any,
    async execute(_args, context) {
      return {
        content: String((context as Record<string, unknown>).sessionId ?? "no-session")
      };
    },
    help: { usage: "/session" }
  }));

  const commandBus = new CommandBus({
    registry: commandRegistry
  });

  const flowEngine = new FlowEngine({
    sessions: repositories.sessions,
    messages: repositories.messages,
    modelGateway: {
      async generateText(input: {
        sessionId: string;
        prompt: string;
        requestId: string;
        flowId: string;
      }) {
        const result = await modelGateway.generateText({
          presetId: runtimePreset.id,
          messages: [
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
            model: primaryModel
          },
          createdAt: new Date().toISOString()
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
      }) {
        const result = await commandBus.dispatch(input.commandText, {
          sessionId: input.sessionId
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
    createId,
    now: () => new Date()
  } as any);

  return {
    repositories,
    packageRuntime,
    commandRegistry,
    providerRegistry,
    profileRegistry,
    archiveService,
    observability,
    modelGateway,
    runtimePreset,
    flowEngine
  };
}
