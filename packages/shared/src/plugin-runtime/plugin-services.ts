import type { PluginRuntimeGateway, PluginRuntimeUtils } from "./services.js";

export interface PluginServiceDescriptor {
  readonly pluginId: string;
  readonly name: string;
  /** Versioned, plugin-defined public contract, e.g. "example/rank@1". */
  readonly contract: string;
  readonly description?: string;
}

export interface PluginServiceClient {
  discover(contract: string): Promise<readonly PluginServiceDescriptor[]>;
  call(
    request: {
      readonly pluginId: string;
      readonly name: string;
      readonly contract: string;
      readonly input: unknown;
    },
    /** The call budget includes provider admission and nested service work. */
    options?: {
      readonly signal?: AbortSignal;
      readonly timeoutMs?: number;
    },
  ): Promise<unknown>;
}

/** Services compute values; the calling runtime owns persistent effects. */
export interface PluginServiceContext {
  readonly callerPluginId: string;
  readonly signal: AbortSignal;
  readonly gateway?: PluginRuntimeGateway;
  readonly utils?: PluginRuntimeUtils;
  readonly services: PluginServiceClient;
}

export interface PluginServiceDefinition<Input, Output> {
  readonly name: string;
  readonly contract: string;
  readonly description?: string;
  /** Structural parser interface; Zod schemas work without a host dependency. */
  readonly input: { parse(value: unknown): Input };
  readonly output: { parse(value: unknown): Output };
  readonly handler: (
    input: Input,
    context: PluginServiceContext,
  ) => Promise<Output> | Output;
}
