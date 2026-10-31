import type { PluginRuntimeGateway, PluginRuntimeUtils } from "./services.js";

export interface PluginServiceDescriptor {
  readonly pluginId: string;
  readonly name: string;
  /** Versioned, plugin-defined public contract, e.g. "example.rank@1". */
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

/**
 * What a read service's handler receives. A read service computes values;
 * the calling runtime owns persistent effects.
 */
export interface PluginServiceContext {
  readonly callerPluginId: string;
  readonly sessionId: string;
  readonly locale?: string;
  /** Detached, read-only access to the provider's own non-hidden data. */
  readonly pluginData: import("@covel/plugin-handlers-utils").PluginDataReader;
  readonly world: import("../proposals/world-model.js").WorldModelView;
  readonly getOwnSettings: () => Readonly<Record<string, unknown>>;
  readonly signal: AbortSignal;
  readonly gateway?: PluginRuntimeGateway;
  readonly utils?: PluginRuntimeUtils;
  readonly services: PluginServiceClient;
}

/**
 * What a write service's handler receives: no model or HTTP access, and a
 * writer for the provider's own data. Its writes are staged for the caller
 * and commit with the caller's work. Nested `services` calls reach read
 * services only.
 */
export interface PluginWriteServiceContext extends Omit<
  PluginServiceContext,
  "pluginData" | "gateway" | "utils"
> {
  /**
   * The provider's own data. Reads see what earlier calls of this caller
   * staged and this call's own writes; `_` namespaces are refused.
   */
  readonly pluginData: import("./handler.js").PluginDataWriter;
  readonly random: import("./handler.js").PluginRandom;
  /** The calling execution's turn. */
  readonly turnId: string;
}

interface PluginServiceDefinitionFields<Input, Output> {
  readonly name: string;
  readonly contract: string;
  /** Required for a model-facing service: the imported tool's description. */
  readonly description?: string;
  /**
   * `true` lets agents import the service as a tool. Must match the
   * `contributes.services` declaration, and needs a description and an input
   * that exports JSON Schema: a Zod schema, or `inputSchema`.
   */
  readonly modelFacing?: boolean;
  /**
   * The JSON Schema (root `type: "object"`) the imported tool shows the
   * model, for an input that is not a Zod schema. The provider's `input`
   * still validates the call.
   */
  readonly inputSchema?: Readonly<Record<string, unknown>>;
  /** Structural parser interface; Zod schemas work without a host dependency. */
  readonly input: { parse(value: unknown): Input };
  readonly output: { parse(value: unknown): Output };
}

/** A service that reads; `access` must match the `contributes.services` entry. */
export interface PluginReadServiceDefinition<
  Input,
  Output,
> extends PluginServiceDefinitionFields<Input, Output> {
  readonly access?: "read";
  readonly handler: (
    input: Input,
    context: PluginServiceContext,
  ) => Promise<Output> | Output;
}

/** A service that changes its provider's own data for the caller. */
export interface PluginWriteServiceDefinition<
  Input,
  Output,
> extends PluginServiceDefinitionFields<Input, Output> {
  readonly access: "write";
  readonly handler: (
    input: Input,
    context: PluginWriteServiceContext,
  ) => Promise<Output> | Output;
}

export type PluginServiceDefinition<Input, Output> =
  | PluginReadServiceDefinition<Input, Output>
  | PluginWriteServiceDefinition<Input, Output>;
