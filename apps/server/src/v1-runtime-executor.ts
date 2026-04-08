import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { createEventBus, createScopedLogger } from "@covel/event-bus";
import {
  parseLlmConfig,
  createProviderRegistry,
  createPresetRegistry,
  createSlotRegistry,
  createGateway,
  type GatewayOptions,
  type TextGenerationResult,
  type ToolDefinition,
  type TextMessage,
  type ImageGenerationResult,
  loadLlmConfig,
} from "@covel/ai-provider";
import type { LoadedRuntime } from "@covel/plugin-manager";
import type { PublishedRecord } from "@covel/services";
import { createRuntimeContext, failedResult, parseStructuredOutput, successResult, wrapAsPublishedRecord, approvalDeniedResult } from "@covel/runtime-context";
import type { V1RuntimeResult, V1SessionState, V1TriggerInput } from "@covel/kernel";
import type { ServiceGateway } from "@covel/services";

type RuntimeGateway = ReturnType<typeof createGateway>;

interface RuntimeGatewayBundle {
  gateway: RuntimeGateway;
  presetId: string;
  slotTag: string;
  imageApi?: string;
}

export interface V1RuntimeExecutorDeps {
  services: ServiceGateway & {
    recordStore?: { publish(record: PublishedRecord): void };
  };
  resolveGatewayForRuntime(runtime: LoadedRuntime): Promise<RuntimeGatewayBundle>;
}

interface PendingDomainEvent {
  eventType: string;
  data?: Record<string, unknown>;
}

interface PendingTableWrite {
  action: "insert" | "update" | "upsert" | "delete";
  table: string;
  key: string;
  data?: unknown;
}

interface PendingSchemaPatch {
  table: string;
  patch: Record<string, unknown>;
}

interface BuiltInToolSpec {
  qualifiedId: string;
  description: string;
  parameters: Record<string, unknown>;
  invoke(args: Record<string, unknown>): Promise<{
    success: boolean;
    output: unknown;
    approvalDenied?: boolean;
  }>;
}

interface ModelToolSpec {
  toolName: string;
  qualifiedId: string;
  description?: string;
  parameters?: Record<string, unknown>;
  invoke(args: Record<string, unknown>) : Promise<{
    success: boolean;
    output: unknown;
    approvalDenied?: boolean;
  }>;
}

export function createV1RuntimeExecutor(deps: V1RuntimeExecutorDeps) {
  return async function executeRuntime(
    runtime: LoadedRuntime,
    input: V1TriggerInput,
    sessionState: V1SessionState,
  ): Promise<V1RuntimeResult> {
    const locale = "zh-CN";
    const runId = `run-${randomUUID()}`;
    const traceId = `trace-${randomUUID()}`;
    const pluginPrompt = runtime.pluginPromptPath ? await readFile(runtime.pluginPromptPath, "utf-8").catch(() => "") : "";
    const instructions = runtime.instructionsPath ? await readFile(runtime.instructionsPath, "utf-8").catch(() => "") : "";
    const outputSchema = runtime.outputSchemaPath
      ? JSON.parse(await readFile(runtime.outputSchemaPath, "utf-8"))
      : { type: "object" };

    const settings = await resolveRuntimeSettings(deps.services, sessionState.sessionId, runtime);
    const logger = createScopedLogger({
      pluginId: runtime.pluginId,
      runtimeId: runtime.manifest.id,
      sessionId: sessionState.sessionId,
      turnId: input.turnId,
      traceId,
    });
    const bus = createEventBus().scope(`${runtime.pluginId}.${runtime.manifest.id}`);

    await deps.services.trace.append({
      kind: "runtime_start",
      sessionId: sessionState.sessionId,
      turnId: input.turnId,
      runId,
      traceId,
      pluginId: runtime.pluginId,
      runtimeId: runtime.manifest.id,
      timestamp: new Date().toISOString(),
      data: { trigger: input.type },
    });

    const pendingTableWrites: PendingTableWrite[] = [];
    const pendingSchemaPatches: PendingSchemaPatch[] = [];
    const pendingDomainEvents: PendingDomainEvent[] = [];

    const externalTools = await deps.services.tools.listAvailable(runtime.manifest.id, runtime.pluginId);
    const builtInTools = createBuiltInToolSpecs({
      runtime,
      services: deps.services,
      sessionId: sessionState.sessionId,
      turnId: input.turnId,
      runId,
      traceId,
      pendingTableWrites,
      pendingSchemaPatches,
      pendingDomainEvents,
    });

    const runtimeContext = createRuntimeContext({
      runtimeId: runtime.manifest.id,
      pluginId: runtime.pluginId,
      sessionId: sessionState.sessionId,
      turnId: input.turnId,
      locale,
      settings,
      promptInput: {
        pluginPrompt,
        instructions,
        locale,
        toolDefinitions: [
          ...builtInTools.map((tool) => ({
            qualifiedId: tool.qualifiedId,
            description: tool.description,
            inputSchema: tool.parameters,
          })),
          ...externalTools.map((tool) => ({
            qualifiedId: tool.qualifiedId,
            description: tool.description,
            inputSchema: tool.inputSchema,
          })),
        ],
        contextSections: buildContextSections(input.payload, settings),
      },
      bus,
      logger,
      records: deps.services.records,
      tables: deps.services.tables,
      tools: deps.services.tools,
      scripts: deps.services.scripts,
      references: deps.services.references,
      approvals: deps.services.approvals,
    });

    const gatewayBundle = await deps.resolveGatewayForRuntime(runtime);

    let result;
    if (gatewayBundle.slotTag === "image") {
      result = await executeImageRuntime({
        runtime,
        runtimeContext,
        gatewayBundle,
        input,
      });
    } else {
      result = await executeTextRuntime({
        runtime,
        runtimeContext,
        gatewayBundle,
        input,
        builtInTools,
        externalTools,
        services: deps.services,
      });
    }

    if (result.status === "success") {
      for (const patch of pendingSchemaPatches) {
        await deps.services.tables.patchSchema({
          table: patch.table,
          patch: patch.patch,
          callerPluginId: runtime.pluginId,
          callerRuntimeId: runtime.manifest.id,
          runId,
        });
      }

      for (const write of pendingTableWrites) {
        if ((deps.services.tables as any).getOwner?.(write.table) === undefined && write.table.startsWith(`${runtime.pluginId}.`)) {
          (deps.services.tables as any).createTable?.(write.table, runtime.pluginId);
        }
        await deps.services.tables.write({
          ...write,
          callerPluginId: runtime.pluginId,
        });
      }

      for (const event of pendingDomainEvents) {
        const record = {
          recordType: "domain_event",
          pluginId: runtime.pluginId,
          runtimeId: runtime.manifest.id,
          sessionId: sessionState.sessionId,
          turnId: input.turnId,
          runId,
          traceId,
          status: "success" as const,
          timestamp: new Date().toISOString(),
          locale,
          payload: event,
        };
        sessionState.records.push(record);
        deps.services.recordStore?.publish(record);
        sessionState.eventQueue.push(event.eventType);
      }
    }

    const record = wrapAsPublishedRecord(result, {
      pluginId: runtime.pluginId,
      runtimeId: runtime.manifest.id,
      sessionId: sessionState.sessionId,
      turnId: input.turnId,
      runId,
      traceId,
      locale,
    });

    deps.services.recordStore?.publish(record);
    await deps.services.trace.append({
      kind: "runtime_end",
      sessionId: sessionState.sessionId,
      turnId: input.turnId,
      runId,
      traceId,
      pluginId: runtime.pluginId,
      runtimeId: runtime.manifest.id,
      timestamp: new Date().toISOString(),
      data: {
        status: result.status,
      },
    });

    return {
      pluginId: runtime.pluginId,
      runtimeId: runtime.manifest.id,
      status: result.status,
      payload: result.payload,
      failureReason: result.failureReason,
      record,
    };
  };
}

async function resolveRuntimeSettings(
  services: ServiceGateway,
  sessionId: string,
  runtime: LoadedRuntime,
): Promise<Record<string, unknown>> {
  const defaults = Object.fromEntries(
    (runtime.manifest.settings ?? []).map((setting) => [setting.key, setting.default]),
  );
  const overrides = await services.settings.getResolved(sessionId, runtime.pluginId, runtime.manifest.id);
  return { ...defaults, ...overrides };
}

function buildContextSections(payload: unknown, settings: Record<string, unknown>) {
  const sections: Array<{ title: string; content: string; priority?: number }> = [];
  if (payload !== undefined) {
    sections.push({
      title: "input",
      content: JSON.stringify(payload, null, 2),
      priority: 20,
    });
  }
  if (Object.keys(settings).length > 0) {
    sections.push({
      title: "settings",
      content: JSON.stringify(settings, null, 2),
      priority: 10,
    });
  }
  return sections;
}

async function executeImageRuntime(args: {
  runtime: LoadedRuntime;
  runtimeContext: ReturnType<typeof createRuntimeContext>;
  gatewayBundle: RuntimeGatewayBundle;
  input: V1TriggerInput;
}) {
  const previousPayload =
    isRecord(args.input.payload) && isRecord(args.input.payload.previousStep) && isRecord(args.input.payload.previousStep.payload)
      ? args.input.payload.previousStep.payload
      : undefined;
  const prompt =
    typeof previousPayload?.enhancedPrompt === "string"
      ? previousPayload.enhancedPrompt
      : JSON.stringify(args.input.payload ?? {});

  const imageResult = await args.gatewayBundle.gateway.generateImage({
    presetId: args.gatewayBundle.presetId,
    prompt,
    providerRequestMetadata: args.gatewayBundle.imageApi
      ? { imageFormat: args.gatewayBundle.imageApi }
      : undefined,
  });

  const firstImage = imageResult.images[0];
  const imageUrl = firstImage?.url
    ?? (firstImage?.dataBase64 && firstImage?.mimeType
      ? `data:${firstImage.mimeType};base64,${firstImage.dataBase64}`
      : "");

  return successResult({
    messageId: typeof previousPayload?.messageId === "string" ? previousPayload.messageId : "unknown",
    status: imageUrl ? "ready" : "error",
    imageUrl,
    caption: typeof previousPayload?.caption === "string" ? previousPayload.caption : "",
  });
}

async function executeTextRuntime(args: {
  runtime: LoadedRuntime;
  runtimeContext: ReturnType<typeof createRuntimeContext>;
  gatewayBundle: RuntimeGatewayBundle;
  input: V1TriggerInput;
  builtInTools: BuiltInToolSpec[];
  externalTools: Awaited<ReturnType<ServiceGateway["tools"]["listAvailable"]>>;
  services: ServiceGateway;
}) {
  const outputSchema = args.runtime.outputSchemaPath
    ? JSON.parse(await readFile(args.runtime.outputSchemaPath, "utf-8"))
    : { type: "object" };
  const messages: TextMessage[] = [
    { role: "system", content: args.runtimeContext.prompt.systemPrompt },
    {
      role: "user",
      content: JSON.stringify({
        input: args.input.payload ?? null,
      }),
    },
  ];

  const modelTools = await buildModelTools(args);
  const toolDefinitions: ToolDefinition[] = modelTools.map((tool) => ({
    type: "function",
    function: {
      name: tool.toolName,
      description: tool.description,
      parameters: tool.parameters,
    },
  }));

  const maxSteps = args.runtime.manifest.budget?.maxSteps ?? 5;
  const maxToolCalls = args.runtime.manifest.budget?.maxToolCalls ?? 10;
  let toolCallsProcessed = 0;
  let finalText = "";

  for (let step = 0; step < maxSteps; step++) {
    const llm = await args.gatewayBundle.gateway.generateText({
      presetId: args.gatewayBundle.presetId,
      messages,
      tools: toolDefinitions.length > 0 ? toolDefinitions : undefined,
    });

    if (!llm.toolCalls || llm.toolCalls.length === 0) {
      finalText = llm.text;
      break;
    }

    messages.push({
      role: "assistant",
      content: llm.text || "",
      toolCalls: llm.toolCalls,
    });

    for (const call of llm.toolCalls) {
      if (toolCallsProcessed >= maxToolCalls) {
        messages.push({
          role: "tool",
          content: JSON.stringify({ error: `Tool call limit reached (${maxToolCalls}).` }),
          toolCallId: call.id,
        });
        continue;
      }
      toolCallsProcessed++;

      const tool = modelTools.find((entry) => entry.toolName === call.name);
      if (!tool) {
        messages.push({
          role: "tool",
          content: JSON.stringify({ error: `Unknown tool "${call.name}".` }),
          toolCallId: call.id,
        });
        continue;
      }

      const parsedArgs = safeParseJson(call.arguments);
      if (!isRecord(parsedArgs)) {
        messages.push({
          role: "tool",
          content: JSON.stringify({ error: "Tool arguments must be a JSON object." }),
          toolCallId: call.id,
        });
        continue;
      }

      const toolResult = await tool.invoke(parsedArgs);
      if (toolResult.approvalDenied) {
        return approvalDeniedResult(typeof toolResult.output === "string" ? toolResult.output : undefined);
      }

      messages.push({
        role: "tool",
        content: typeof toolResult.output === "string" ? toolResult.output : JSON.stringify(toolResult.output),
        toolCallId: call.id,
      });
    }
  }

  if (!finalText) {
    return failedResult("Runtime did not produce a final response.");
  }

  const parsed = parseStructuredOutput(finalText, { outputSchema });
  if (!parsed.success) {
    return failedResult("Structured output validation failed.", {
      raw: finalText,
      errors: parsed.errors,
    });
  }

  return successResult(parsed.data);
}

async function buildModelTools(args: {
  runtime: LoadedRuntime;
  builtInTools: BuiltInToolSpec[];
  externalTools: Awaited<ReturnType<ServiceGateway["tools"]["listAvailable"]>>;
  services: ServiceGateway;
}) : Promise<ModelToolSpec[]> {
  const result: ModelToolSpec[] = [];
  let index = 0;

  for (const tool of args.builtInTools) {
    result.push({
      toolName: `tool_${index++}`,
      qualifiedId: tool.qualifiedId,
      description: tool.description,
      parameters: tool.parameters,
      invoke: tool.invoke,
    });
  }

  for (const tool of args.externalTools) {
    result.push({
      toolName: `tool_${index++}`,
      qualifiedId: tool.qualifiedId,
      description: tool.description,
      parameters: tool.inputSchema,
      invoke: async (input) => {
        const result = await args.services.tools.invoke({
          qualifiedToolId: tool.qualifiedId,
          input,
          callerPluginId: args.runtime.pluginId,
          callerRuntimeId: args.runtime.manifest.id,
          sessionId: "",
          turnId: "",
          traceId: `trace-${randomUUID()}`,
          locale: "zh-CN",
        });
        return {
          success: result.success,
          output: result.output ?? { error: result.error },
          approvalDenied: !!result.interactionId,
        };
      },
    });
  }

  return result;
}

function createBuiltInToolSpecs(args: {
  runtime: LoadedRuntime;
  services: ServiceGateway;
  sessionId: string;
  turnId: string;
  runId: string;
  traceId: string;
  pendingTableWrites: PendingTableWrite[];
  pendingSchemaPatches: PendingSchemaPatch[];
  pendingDomainEvents: PendingDomainEvent[];
}): BuiltInToolSpec[] {
  const allowedTablePatterns = args.runtime.manifest.tableAccess?.read ?? [];
  const scriptsDir = join(args.runtime.dir, "scripts");
  const referencesDir = join(args.runtime.dir, "references");

  const all: BuiltInToolSpec[] = [
    {
      qualifiedId: "kernel:query_records",
      description: "Query published records for the current session.",
      parameters: {
        type: "object",
        properties: {
          pluginId: { type: "string" },
          runtimeId: { type: "string" },
          status: { type: "array", items: { type: "string" } },
          recordType: { type: "string" },
          limit: { type: "integer" },
        },
      },
      invoke: async (input) => ({
        success: true,
        output: await args.services.records.query({
          sessionId: args.sessionId,
          pluginId: typeof input.pluginId === "string" ? input.pluginId : undefined,
          runtimeId: typeof input.runtimeId === "string" ? input.runtimeId : undefined,
          status: Array.isArray(input.status) ? input.status.filter((x): x is string => typeof x === "string") : undefined,
          recordType: typeof input.recordType === "string" ? input.recordType as any : undefined,
          limit: typeof input.limit === "number" ? input.limit : undefined,
        }),
      }),
    },
    {
      qualifiedId: "kernel:query_tables",
      description: "Query live state tables using declared access patterns.",
      parameters: {
        type: "object",
        properties: {
          mode: { type: "string", enum: ["latest", "history", "diff"] },
          table: { type: "string" },
          filters: { type: "object" },
          limit: { type: "integer" },
        },
        required: ["mode", "table"],
      },
      invoke: async (input) => ({
        success: true,
        output: await args.services.tables.query({
          mode: typeof input.mode === "string" ? input.mode as any : "latest",
          table: String(input.table ?? ""),
          filters: isRecord(input.filters) ? input.filters : undefined,
          limit: typeof input.limit === "number" ? input.limit : undefined,
          callerPluginId: args.runtime.pluginId,
          allowedPatterns: allowedTablePatterns,
        }),
      }),
    },
    {
      qualifiedId: "kernel:write_table",
      description: "Queue a write into a table owned by the current plugin.",
      parameters: {
        type: "object",
        properties: {
          action: { type: "string", enum: ["insert", "update", "upsert", "delete"] },
          table: { type: "string" },
          key: { type: "string" },
          data: {},
        },
        required: ["action", "table", "key"],
      },
      invoke: async (input) => {
        args.pendingTableWrites.push({
          action: String(input.action ?? "upsert") as any,
          table: String(input.table ?? ""),
          key: String(input.key ?? ""),
          data: input.data,
        });
        return { success: true, output: { queued: true } };
      },
    },
    {
      qualifiedId: "kernel:patch_table_schema",
      description: "Queue a compatible schema patch for a table owned by the current plugin.",
      parameters: {
        type: "object",
        properties: {
          table: { type: "string" },
          patch: { type: "object" },
        },
        required: ["table", "patch"],
      },
      invoke: async (input) => {
        args.pendingSchemaPatches.push({
          table: String(input.table ?? ""),
          patch: isRecord(input.patch) ? input.patch : {},
        });
        return { success: true, output: { queued: true } };
      },
    },
    {
      qualifiedId: "kernel:emit_domain_event",
      description: "Queue a domain event that will be recorded after runtime success.",
      parameters: {
        type: "object",
        properties: {
          eventType: { type: "string" },
          data: { type: "object" },
        },
        required: ["eventType"],
      },
      invoke: async (input) => {
        args.pendingDomainEvents.push({
          eventType: String(input.eventType ?? ""),
          data: isRecord(input.data) ? input.data : undefined,
        });
        return { success: true, output: { queued: true } };
      },
    },
    {
      qualifiedId: "kernel:exec_script",
      description: "Execute a script from the current runtime scripts directory.",
      parameters: {
        type: "object",
        properties: {
          script: { type: "string" },
          args: { type: "object" },
        },
        required: ["script"],
      },
      invoke: async (input) => ({
        success: true,
        output: await args.services.scripts.exec({
          script: String(input.script ?? ""),
          args: isRecord(input.args) ? input.args : {},
          scriptsDir,
        }),
      }),
    },
    {
      qualifiedId: "kernel:load_reference",
      description: "Load a reference file from the current runtime references directory.",
      parameters: {
        type: "object",
        properties: {
          file: { type: "string" },
        },
        required: ["file"],
      },
      invoke: async (input) => ({
        success: true,
        output: await args.services.references.load({
          file: String(input.file ?? ""),
          referencesDir,
        }),
      }),
    },
    {
      qualifiedId: "kernel:request_interaction",
      description: "Request a frontend interaction. Returns a synthetic interaction identifier.",
      parameters: {
        type: "object",
        properties: {
          type: { type: "string" },
          payload: { type: "object" },
        },
        required: ["type"],
      },
      invoke: async (input) => ({
        success: true,
        output: {
          interactionId: `interaction:${args.sessionId}:${args.runtime.pluginId}:${randomUUID()}`,
          type: String(input.type ?? "interaction"),
        },
      }),
    },
  ];

  const allowed = new Set(args.runtime.manifest.systemTools ?? []);
  return all.filter((tool) => allowed.has(tool.qualifiedId));
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function safeParseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

export function createRuntimeGatewayResolver() {
  const cache = new Map<string, RuntimeGatewayBundle>();

  return async function resolveGatewayForRuntime(runtime: LoadedRuntime): Promise<RuntimeGatewayBundle> {
    if (!runtime.llmConfigPath) {
      throw new Error(`Runtime "${runtime.pluginId}:${runtime.manifest.id}" has no llm.toml.`);
    }
    const cached = cache.get(runtime.llmConfigPath);
    if (cached) return cached;

    const loaded = loadLlmConfig(runtime.llmConfigPath);
    if (!loaded) {
      throw new Error(`Could not load llm config for runtime "${runtime.pluginId}:${runtime.manifest.id}".`);
    }
    const { aiConfig, llmConfig } = loaded;
    const providerRegistry = createProviderRegistry({ providerDefaults: aiConfig.providers });
    const presetRegistry = createPresetRegistry({
      profiles: aiConfig.profiles,
      presets: aiConfig.presets,
    });
    const slotRegistry = createSlotRegistry({ presetRegistry });
    const slots: Record<string, any> = {};
    for (const preset of aiConfig.presets) {
      if (preset.defaultSlot && preset.enabled) {
        slots[preset.defaultSlot] = {
          slotId: preset.defaultSlot,
          presetId: preset.id,
          tag: preset.tag ?? "text",
          ...(preset.imageApi ? { imageApi: preset.imageApi } : {}),
        };
      }
    }
    slotRegistry.configure({ slots });
    const gateway = createGateway({ providerRegistry, presetRegistry, slotRegistry });
    const presetId = gateway.resolveSlotToPresetId("plugin") ?? "plugin";
    const slotTag = slotRegistry.getSlotTag("plugin") ?? "text";
    const imageApi = llmConfig.slots.plugin?.imageApi;

    const bundle = { gateway, presetId, slotTag, imageApi };
    cache.set(runtime.llmConfigPath, bundle);
    return bundle;
  };
}
