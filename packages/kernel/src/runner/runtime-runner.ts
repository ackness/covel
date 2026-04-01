import { readFile } from "node:fs/promises";
import type { RuntimeContextView } from "@covel/shared";
import type {
  RegisteredRuntime,
  ToolRegistry,
  HookRegistry,
} from "@covel/plugin-runtime";
import type { GatewayLike, RuntimeExecutorInput } from "@covel/runtime";
import { createRuntimeExecutor } from "@covel/runtime";
import { executeTool } from "../tools/tool-executor.js";
import type { ContextFragment } from "../context/context-provider-bridge.js";

export interface RuntimeRunnerDeps {
  gateway: GatewayLike;
  toolRegistry: ToolRegistry;
  hookRegistry: HookRegistry;
}

export interface RuntimeRunResult {
  text: string;
  proposals: Array<{ kind: string; payload: unknown }>;
  usage: { inputTokens: number; outputTokens: number };
}

/**
 * Drive a single runtime's execution.
 *
 * If the runtime has a registered handler, use it directly (no LLM).
 * Otherwise, call the LLM via the gateway.
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
  }
): Promise<RuntimeRunResult> {
  // Load instructions if available
  let instructions: string | undefined;
  if (runtime.instructionsPath) {
    try {
      instructions = await readFile(runtime.instructionsPath, "utf-8");
    } catch {
      // Instructions file not readable, continue without
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
    const result = await runtime.handler({
      runtimeId: runtime.spec.id,
      pluginId: runtime.pluginId,
      locale: context.locale,
      context,
      instructions,
    });

    return {
      text: "",
      proposals: result.proposals,
      usage: { inputTokens: 0, outputTokens: 0 },
    };
  }

  // ── LLM path ───────────────────────────────────────────────────
  const executor = createRuntimeExecutor(deps.gateway);

  const executorInput: RuntimeExecutorInput = {
    context,
    instructions,
    presetId: runtime.spec.providerBinding,
    apiKeys: options.apiKeys,
    traceId: options.traceId,
  };

  const result = await executor.execute(executorInput);

  // Collect proposals from the narrative output
  const proposals: Array<{ kind: string; payload: unknown }> = [];

  // The primary runtime output is treated as a narrative.append proposal
  if (result.text) {
    proposals.push({
      kind: "narrative.append",
      payload: { text: result.text },
    });
  }

  return {
    text: result.text,
    proposals,
    usage: result.usage,
  };
}
