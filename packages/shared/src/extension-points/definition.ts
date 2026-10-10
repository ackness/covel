import type { PluginServiceContext } from "../plugin-runtime/plugin-services.js";

export interface ExtensionDeclaration {
  readonly point: string;
  readonly id: string;
  readonly order?: number;
  readonly slot?: string;
  readonly watch?: readonly string[];
  readonly preview?: readonly string[];
}

export type ExtensionMode = "single" | "collect" | "pipeline";

export interface ExtensionPoint<I, O, M extends ExtensionMode = ExtensionMode> {
  readonly id: string;
  readonly mode: M;
  readonly input: { parse(value: unknown): I };
  readonly output: { parse(value: unknown): O };
  readonly timeoutMs: number;
  readonly onError: "skip" | "fail-turn";
  /** Required when pipeline outputs cannot be merged into object inputs. */
  nextInput?(previous: I, output: O): I;
  initialOutput?(input: I): O;
  matchesProvider?(input: I, provider: ExtensionProviderDescriptor): boolean;
  /** Kernel-owned provenance; provider-controlled attribution is overwritten. */
  attributeOutput?(output: O, provider: ExtensionProviderDescriptor): O;
}

export function defineExtensionPoint<I, O, M extends ExtensionMode>(
  point: ExtensionPoint<I, O, M>,
): ExtensionPoint<I, O, M> {
  if (!/^[a-z][a-z0-9.-]*@[1-9][0-9]*$/.test(point.id))
    throw new Error("Extension point requires a versioned kernel contract");
  if (
    !Number.isFinite(point.timeoutMs) ||
    point.timeoutMs <= 0 ||
    point.timeoutMs > 2_147_483_647
  )
    throw new Error(
      "Extension timeout must be positive and at most 2147483647",
    );
  return Object.freeze({ ...point });
}

/** A row as the host reads it for an execution; providers see entries. */
export interface ExtensionPluginDataRecord {
  readonly pluginId: string;
  readonly namespace: string;
  readonly key: string;
  readonly value: unknown;
  readonly sessionId?: string;
  readonly id?: string;
  readonly createdAt?: string;
  readonly updatedAt?: string;
}

export interface PluginExtensionContext extends PluginServiceContext {
  readonly world: import("../proposals/world-model.js").WorldModelView;
  readonly sessionId: string;
  readonly locale: string;
  /** The provider plugin's translations for the session's language. */
  readonly messages?: import("../utils/plugin-messages.js").PluginMessages;
  readonly turnId?: string;
  /** Detached copies, shaped as `ctx.pluginData` of a function handler. */
  readonly pluginData: import("@covel/plugin-handlers-utils").PluginDataReader;
}

export interface PluginExtensionDefinition<I = unknown, O = unknown> {
  readonly handler: (
    input: I,
    context: PluginExtensionContext,
  ) => O | Promise<O>;
}

export interface ExtensionProviderDescriptor extends ExtensionDeclaration {
  readonly pluginId: string;
  /** Internal service identity, useful for correlating service diagnostics. */
  readonly name: string;
}

export type ExtensionResult<O, M extends ExtensionMode> = M extends "collect"
  ? readonly O[]
  : M extends "single"
    ? O | undefined
    : O;
