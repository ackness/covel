import { readFile } from "node:fs/promises";
import type { RuntimeContextView, PluginDataAccess, PublicToolDefinition } from "@covel/shared";
import type {
  RegisteredRuntime,
  ScopedToolRegistry,
  ScopedHookRegistry,
} from "@covel/plugin-runtime";
import type {
  GatewayLike,
  RuntimeExecutorInput,
} from "@covel/runtime";
import type {
  SlotRegistry,
  ToolDefinition,
  TextMessage,
  ToolCallPart,
} from "@covel/ai-provider";
import { createRuntimeExecutor, buildPrompt } from "@covel/runtime";
import { executeTool } from "../tools/tool-executor.js";
import type { ContextFragment } from "@covel/context";
import type { KernelProgressEvent } from "../types.js";
import {
  DEFAULT_MAX_STEPS,
  DEFAULT_MAX_STEPS_NO_TOOLS,
  DEFAULT_MAX_TOOL_CALLS,
  DEFAULT_TOOL_TIMEOUT_MS,
} from "../types.js";

export interface RuntimeRunnerDeps {
  gateway: GatewayLike;
  toolRegistry: ScopedToolRegistry;
  hookRegistry: ScopedHookRegistry;
  slotRegistry?: SlotRegistry;
}

export interface RuntimeRunResult {
  text: string;
  proposals: Array<{ kind: string; payload: unknown }>;
  usage: { inputTokens: number; outputTokens: number };
}

/** Callback for progress events during runtime execution. */
export type RuntimeProgressCallback = (
  evt: Omit<KernelProgressEvent, "timestamp">
) => void;

/**
 * Drive a single runtime's execution.
 *
 * If the runtime has a registered handler, use it directly (no LLM).
 * Otherwise, call the LLM via the gateway with an agentic tool-calling loop.
 *
 * Context fragments from providers are prepended to the instructions
 * so plugins like core-persona can inject narrator persona and world
 * context into the LLM prompt.
 */
export async function runRuntime(
  deps: RuntimeRunnerDeps,
  runtime: RegisteredRuntime,
  context: RuntimeContextView,
  options: {
    apiKeys?: Record<string, string>;
    traceId?: string;
    contextFragments?: ContextFragment[];
    dataAccess?: PluginDataAccess;
    /** Pre-resolved preset ID (from per-request slot overrides). Takes priority over slot registry. */
    resolvedPresetId?: string;
    /** Progress callback for tool-calling events. */
    onProgress?: RuntimeProgressCallback;
  }
): Promise<RuntimeRunResult> {
  // Load instructions if available
  let instructions: string | undefined;
  if (runtime.instructionsPath) {
    try {
      instructions = await readFile(runtime.instructionsPath, "utf-8");
    } catch (err) {
      console.warn(`[runtime-runner] Failed to read instructions from "${runtime.instructionsPath}":`, err);
    }
  }

  // Prepend context fragments from providers (sorted by priority)
  if (options.contextFragments && options.contextFragments.length > 0) {
    const fragmentText = options.contextFragments
      .map((f) => f.content)
      .join("\n\n");
    instructions = instructions
      ? `${fragmentText}\n\n${instructions}`
      : fragmentText;
  }

  // ── Custom handler path (no LLM) ───────────────────────────────
  if (runtime.handler) {
    // Provide a generateText helper so handlers can optionally call the LLM
    const generateText = async (prompt: string): Promise<string> => {
      const binding = runtime.spec.providerBinding;
      let presetId: string | undefined = options.resolvedPresetId ?? binding;
      if (!options.resolvedPresetId && binding && deps.slotRegistry) {
        const resolved = deps.slotRegistry.resolveSlot(binding);
        if (resolved) presetId = resolved;
      }
      const result = await deps.gateway.generateText(
        { presetId, messages: [{ role: "user", content: prompt }] },
        { apiKeys: options.apiKeys, traceId: options.traceId }
      );
      return result.text;
    };

    const result = await runtime.handler({
      runtimeId: runtime.spec.id,
      pluginId: runtime.pluginId,
      locale: context.locale,
      context,
      instructions,
      data: options.dataAccess,
      generateText,
    });

    return {
      text: "",
      proposals: result.proposals,
      usage: { inputTokens: 0, outputTokens: 0 },
    };
  }

  // ── LLM path with tool-calling loop ────────────────────────────
  const executor = createRuntimeExecutor(deps.gateway);

  // Resolve providerBinding to an actual presetId.
  const binding = runtime.spec.providerBinding;
  let presetId: string | undefined = options.resolvedPresetId ?? binding;
  let providerRequestMetadata: Record<string, unknown> | undefined;

  if (!options.resolvedPresetId && binding && deps.slotRegistry) {
    const resolved = deps.slotRegistry.resolveSlot(binding);
    if (resolved) {
      presetId = resolved;
    }
    const overrides = deps.slotRegistry.getParameterOverrides(binding);
    if (overrides) {
      providerRequestMetadata = { parameterOverrides: overrides };
    }
  }

  // Resolve tool definitions for this runtime
  const toolDefs = resolveToolDefinitions(
    runtime.spec.tools,
    runtime.pluginId,
    deps.toolRegistry
  );

  const hasTools = toolDefs.length > 0;
  const maxSteps = runtime.spec.budget?.maxSteps ?? (hasTools ? DEFAULT_MAX_STEPS : DEFAULT_MAX_STEPS_NO_TOOLS);
  const maxToolCalls = runtime.spec.budget?.maxToolCalls ?? DEFAULT_MAX_TOOL_CALLS;
  const toolTimeoutMs = runtime.spec.budget?.toolTimeoutMs ?? DEFAULT_TOOL_TIMEOUT_MS;

  // Build initial messages via the executor's prompt builder
  const executorInput: RuntimeExecutorInput = {
    context,
    instructions,
    presetId,
    apiKeys: options.apiKeys,
    traceId: options.traceId,
    providerRequestMetadata,
  };

  // If no tools, use streaming path for real-time token display
  if (!hasTools) {
    let fullText = "";
    const streamUsage = { inputTokens: 0, outputTokens: 0 };

    for await (const event of executor.stream(executorInput)) {
      if (event.type === "text-delta") {
        fullText += event.textDelta;
        options.onProgress?.({
          type: "message.delta",
          runtimeId: runtime.spec.id,
          pluginId: runtime.pluginId,
          label: runtime.pluginId,
          detail: event.textDelta,
        });
      } else if (event.type === "done") {
        streamUsage.inputTokens = event.usage.inputTokens;
        streamUsage.outputTokens = event.usage.outputTokens;
      }
    }

    const proposals: Array<{ kind: string; payload: unknown }> = [];
    if (fullText) {
      proposals.push({ kind: "narrative.append", payload: { text: fullText } });
    }
    return { text: fullText, proposals, usage: streamUsage };
  }

  // ── Agentic tool-calling loop ──────────────────────────────────
  const allProposals: Array<{ kind: string; payload: unknown }> = [];
  const totalUsage = { inputTokens: 0, outputTokens: 0 };
  let finalText = "";
  let toolCallsProcessed = 0;

  // Build messages from context (reuse executor's prompt builder logic)
  const messages: TextMessage[] = buildPrompt(context, {
    instructions,
    locale: context.locale,
  });

  // Sanitize qualified tool IDs for OpenAI compatibility:
  // OpenAI requires tool names to match ^[a-zA-Z0-9_-]+$ (no colons).
  // We replace ":" with "__" and maintain a bidirectional mapping.
  const sanitizeToolName = (qualifiedId: string): string =>
    qualifiedId.replace(/:/g, "__");
  const desanitizeToolName = (sanitized: string): string =>
    sanitized.replace(/__/g, ":");

  const toolDefinitions: ToolDefinition[] = toolDefs.map((td) => ({
    type: "function",
    function: {
      name: sanitizeToolName(td.qualifiedId),
      description: td.description,
      parameters: td.parameters,
    },
  }));

  // Fix 2: Build whitelist set from resolved tool definitions (using sanitized names)
  const allowedToolNames = new Set(toolDefs.map((td) => sanitizeToolName(td.qualifiedId)));

  // Fix 3: Wire AbortSignal/timeoutMs
  const timeoutMs = runtime.spec.budget?.timeoutMs;
  const ac = timeoutMs ? new AbortController() : undefined;
  const timeoutHandle = timeoutMs && ac
    ? setTimeout(() => ac.abort(), timeoutMs)
    : undefined;

  try {
    for (let step = 0; step < maxSteps; step++) {
      const result = await deps.gateway.generateText(
        {
          presetId,
          messages,
          tools: toolDefinitions,
          providerRequestMetadata,
        },
        {
          apiKeys: options.apiKeys,
          traceId: options.traceId,
          signal: ac?.signal,
        }
      );

      totalUsage.inputTokens += result.usage.inputTokens;
      totalUsage.outputTokens += result.usage.outputTokens;

      // No tool calls — final response
      if (!result.toolCalls || result.toolCalls.length === 0) {
        finalText = result.text;
        break;
      }

      // Append assistant message with tool_calls to conversation
      messages.push({
        role: "assistant",
        content: result.text || "",
        toolCalls: result.toolCalls,
      });

      // Execute each tool call
      for (const toolCall of result.toolCalls) {
        // Enforce max total tool invocations
        if (toolCallsProcessed >= maxToolCalls) {
          messages.push({
            role: "tool",
            content: JSON.stringify({
              error: `Tool call limit reached (max ${maxToolCalls}). Produce a final response now.`,
            }),
            toolCallId: toolCall.id,
          });
          continue;
        }

        toolCallsProcessed++;

        // Desanitize tool name back to qualified ID (e.g., "core-combat__start-combat" → "core-combat:start-combat")
        const qualifiedToolId = desanitizeToolName(toolCall.name);

        options.onProgress?.({
          type: "tool.calling",
          runtimeId: runtime.spec.id,
          pluginId: runtime.pluginId,
          label: qualifiedToolId,
          detail: toolCall.arguments,
        });

        let toolOutput: unknown;
        try {
          // Fix 2: Enforce tool whitelist before executeTool
          if (!allowedToolNames.has(toolCall.name)) {
            toolOutput = { error: "Tool not in whitelist for this runtime." };
          } else {
            // Fix 6: Check for parse errors before executing
            const input = safeParseJson(toolCall.arguments);
            if (isParseError(input)) {
              toolOutput = {
                error: "Tool arguments were not valid JSON",
                raw: toolCall.arguments,
              };
            } else {
              const toolResult = await executeTool(
                { toolRegistry: deps.toolRegistry, hookRegistry: deps.hookRegistry },
                {
                  qualifiedToolId,
                  input,
                  runtimeId: runtime.spec.id,
                  pluginId: runtime.pluginId,
                  locale: context.locale,
                  timeoutMs: toolTimeoutMs,
                  state: options.dataAccess?.state.getAll(),
                }
              );

              if (toolResult.blocked) {
                toolOutput = { error: "Tool call blocked by hook." };
              } else {
                toolOutput = toolResult.output;
                allProposals.push(...toolResult.proposals);
              }
            }
          }
        } catch (err) {
          toolOutput = {
            error: err instanceof Error ? err.message : "Tool execution failed.",
          };
        }

        options.onProgress?.({
          type: "tool.completed",
          runtimeId: runtime.spec.id,
          pluginId: runtime.pluginId,
          label: qualifiedToolId,
        });

        // Append tool result message
        messages.push({
          role: "tool",
          content: typeof toolOutput === "string"
            ? toolOutput
            : JSON.stringify(toolOutput),
          toolCallId: toolCall.id,
        });
      }
    }

    // If maxSteps or maxToolCalls exhausted without final text, make a text-only LLM call
    if (!finalText && toolCallsProcessed > 0) {
      try {
        const fallbackResult = await deps.gateway.generateText(
          {
            presetId,
            messages,
            providerRequestMetadata,
          },
          {
            apiKeys: options.apiKeys,
            traceId: options.traceId,
            signal: ac?.signal,
          }
        );
        totalUsage.inputTokens += fallbackResult.usage.inputTokens;
        totalUsage.outputTokens += fallbackResult.usage.outputTokens;
        finalText = fallbackResult.text;
      } catch (err) {
        console.warn(`[runtime-runner] Fallback LLM call failed for runtime "${runtime.spec.id}":`, err);
      }

      if (!finalText) {
        options.onProgress?.({
          type: "runtime.failed",
          runtimeId: runtime.spec.id,
          pluginId: runtime.pluginId,
          label: runtime.pluginId,
          detail: "maxSteps exhausted without final text",
        });
      }
    }
  } finally {
    // Fix 3: Clear timeout in finally block
    if (timeoutHandle !== undefined) {
      clearTimeout(timeoutHandle);
    }
  }

  // Collect final narrative
  if (finalText) {
    allProposals.push({ kind: "narrative.append", payload: { text: finalText } });
  }

  return {
    text: finalText,
    proposals: allProposals,
    usage: totalUsage,
  };
}

// ── Tool resolution helpers ──────────────────────────────────────

interface ResolvedToolDef {
  qualifiedId: string;
  description?: string;
  parameters?: Record<string, unknown>;
}

/**
 * Resolve tool IDs from a runtime's spec into OpenAI-compatible tool definitions.
 *
 * Resolution order for each tool ID:
 * 1. Try as qualified ID directly (pluginId:toolId) in the registry
 * 2. Try prefixed with the runtime's own pluginId (pluginId:toolId)
 * 3. Try as a builtin tool (kernel:toolId)
 */
function resolveToolDefinitions(
  toolIds: string[],
  pluginId: string,
  toolRegistry: ScopedToolRegistry
): ResolvedToolDef[] {
  if (!toolIds || toolIds.length === 0) return [];

  const resolved: ResolvedToolDef[] = [];

  for (const toolId of toolIds) {
    // 1. Try as-is (already qualified, e.g. "other-plugin:some-tool")
    let tool = toolRegistry.getByQualifiedId(toolId);

    // 2. Try with own plugin prefix (e.g. "state.get" → "my-plugin:state.get")
    if (!tool) {
      tool = toolRegistry.getByQualifiedId(`${pluginId}:${toolId}`);
    }

    // 3. Try as builtin (e.g. "state.get" → "kernel:state.get")
    if (!tool) {
      tool = toolRegistry.getByQualifiedId(`kernel:${toolId}`);
    }

    if (tool) {
      const def = tool.definition;
      resolved.push({
        qualifiedId: `${tool.pluginId}:${def.id}`,
        description: buildToolDescription(def),
        parameters: def.schema as Record<string, unknown> | undefined,
      });
    } else {
      console.warn(
        `[runtime-runner] Unresolvable tool ID "${toolId}" for plugin "${pluginId}". ` +
          `Tried: "${toolId}", "${pluginId}:${toolId}", "kernel:${toolId}".`
      );
    }
  }

  return resolved;
}

function buildToolDescription(def: PublicToolDefinition): string {
  const parts: string[] = [];
  if (def.kind) parts.push(`[${def.kind}]`);
  parts.push(def.id);
  // Check if schema has a top-level description
  if (
    def.schema &&
    typeof def.schema === "object" &&
    "description" in def.schema &&
    typeof (def.schema as Record<string, unknown>).description === "string"
  ) {
    parts.push(`— ${(def.schema as Record<string, unknown>).description}`);
  }
  return parts.join(" ");
}

interface ParseError {
  _parseError: true;
  raw: string;
}

function safeParseJson(str: string): unknown | ParseError {
  try {
    return JSON.parse(str);
  } catch {
    return { _parseError: true, raw: str } satisfies ParseError;
  }
}

function isParseError(value: unknown): value is ParseError {
  return (
    typeof value === "object" &&
    value !== null &&
    "_parseError" in value &&
    (value as ParseError)._parseError === true
  );
}
