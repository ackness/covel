/**
 * In-memory ToolClient for builtin and plugin-local tools.
 */

import type { ToolClient, ToolCallResult, ToolDefinition } from "./client.js";
import type { ResolvedTool, ToolExecutionContext } from "./types.js";

export interface InMemoryToolClientOptions {
  readonly id: string;
  readonly tools?: readonly ResolvedTool[];
}

export class InMemoryToolClient implements ToolClient {
  readonly id: string;
  private readonly byFullName = new Map<string, ResolvedTool>();
  private readonly byLocalName = new Map<string, ResolvedTool>();

  constructor(options: InMemoryToolClientOptions) {
    this.id = options.id;
    for (const tool of options.tools ?? []) {
      this.register(tool);
    }
  }

  register(tool: ResolvedTool): void {
    this.byFullName.set(tool.fullName, tool);
    this.byLocalName.set(tool.localName, tool);
  }

  get(name: string): ResolvedTool | undefined {
    return this.byFullName.get(name) ?? this.byLocalName.get(name);
  }

  async list(): Promise<readonly ToolDefinition[]> {
    return [...this.byFullName.values()];
  }

  async call(
    name: string,
    args: unknown,
    ctx: ToolExecutionContext,
  ): Promise<ToolCallResult> {
    const tool = this.get(name);
    if (!tool) {
      throw new Error(`Unknown tool: ${name}`);
    }
    return tool.module.execute(args, ctx);
  }
}
