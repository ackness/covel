import type {
  ApprovalService,
  ResolvedToolDefinition,
  ToolGatewayService,
  ToolInvokeInput,
  ToolInvokeResult,
  TraceService,
} from "./types.js";

interface ToolRegistryLike {
  resolveForRuntime(pluginId: string, runtimeId: string): Array<{
    qualifiedId: string;
    pluginId: string;
    runtimeId: string;
    toolId: string;
    description?: string;
    inputSchema?: Record<string, unknown>;
    outputSchema?: Record<string, unknown>;
    exported: boolean;
    execute: (ctx: unknown) => Promise<unknown>;
  }>;
  getQualified(id: string): {
    qualifiedId: string;
    pluginId: string;
    runtimeId: string;
    toolId: string;
    description?: string;
    inputSchema?: Record<string, unknown>;
    outputSchema?: Record<string, unknown>;
    exported: boolean;
    execute: (ctx: unknown) => Promise<unknown>;
  } | undefined;
}

export interface ToolGatewayConfig {
  registry: ToolRegistryLike;
  approvals: ApprovalService;
  trace: TraceService;
}

export function createToolGatewayService(config: ToolGatewayConfig): ToolGatewayService {
  async function listAvailable(runtimeId: string, pluginId: string): Promise<ResolvedToolDefinition[]> {
    return config.registry.resolveForRuntime(pluginId, runtimeId).map((tool) => ({
      qualifiedId: tool.qualifiedId,
      pluginId: tool.pluginId,
      toolId: tool.toolId,
      description: tool.description,
      inputSchema: tool.inputSchema,
      outputSchema: tool.outputSchema,
      exported: tool.exported,
    }));
  }

  async function invoke(input: ToolInvokeInput): Promise<ToolInvokeResult> {
    await config.trace.append({
      kind: "approval_check",
      sessionId: input.sessionId,
      turnId: input.turnId,
      runId: input.traceId,
      traceId: input.traceId,
      pluginId: input.callerPluginId,
      runtimeId: input.callerRuntimeId,
      timestamp: new Date().toISOString(),
      data: {
        toolId: input.qualifiedToolId,
      },
    });

    const approval = await config.approvals.check({
      sessionId: input.sessionId,
      pluginId: input.callerPluginId,
      toolId: input.qualifiedToolId,
    });

    if (!approval.allowed) {
      const interactionId = `approval:${input.sessionId}:${input.callerPluginId}:${input.qualifiedToolId}`;
      await config.trace.append({
        kind: "approval_decision",
        sessionId: input.sessionId,
        turnId: input.turnId,
        runId: input.traceId,
        traceId: input.traceId,
        pluginId: input.callerPluginId,
        runtimeId: input.callerRuntimeId,
        timestamp: new Date().toISOString(),
        data: {
          toolId: input.qualifiedToolId,
          allowed: false,
          interactionId,
        },
      });
      return {
        success: false,
        output: null,
        error: approval.reason ?? "User approval required.",
        interactionId,
      };
    }

    const tool = config.registry.getQualified(input.qualifiedToolId);
    if (!tool) {
      return {
        success: false,
        output: null,
        error: `Tool "${input.qualifiedToolId}" not found.`,
      };
    }

    await config.trace.append({
      kind: "tool_call",
      sessionId: input.sessionId,
      turnId: input.turnId,
      runId: input.traceId,
      traceId: input.traceId,
      pluginId: input.callerPluginId,
      runtimeId: input.callerRuntimeId,
      timestamp: new Date().toISOString(),
      data: {
        toolId: input.qualifiedToolId,
        input: input.input,
      },
    });

    const output = await tool.execute({
      pluginId: input.callerPluginId,
      runtimeId: input.callerRuntimeId,
      sessionId: input.sessionId,
      turnId: input.turnId,
      traceId: input.traceId,
      locale: input.locale,
      input: input.input,
    });

    await config.trace.append({
      kind: "tool_result",
      sessionId: input.sessionId,
      turnId: input.turnId,
      runId: input.traceId,
      traceId: input.traceId,
      pluginId: input.callerPluginId,
      runtimeId: input.callerRuntimeId,
      timestamp: new Date().toISOString(),
      data: {
        toolId: input.qualifiedToolId,
        output,
      },
    });

    return {
      success: true,
      output,
    };
  }

  return { listAvailable, invoke };
}
