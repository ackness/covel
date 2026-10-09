import type { ModelProviderAdapter } from "../adapters/adapter.js";
import type { ProtocolDefinition } from "../protocol-registry.js";

/**
 * A text protocol a plugin provides. A model slot whose `protocol` is the
 * wire's ID (`<pluginId>/<wireId>`) sends its text, object and stream calls
 * through it, the story model included.
 *
 * The wire owns the HTTP: it receives the slot's resolved endpoint and key
 * and returns the framework's result shapes. `generateText` and `streamText`
 * are the whole contract. `generateObject` defaults to `generateText` with
 * the JSON Schema as an instruction, and embeddings are refused.
 */
export interface TextWire extends Partial<
  Pick<
    ProtocolDefinition,
    | "cacheStrategy"
    | "capabilityDefaults"
    | "reasoningFields"
    | "providerOptionFields"
    | "parameters"
    | "listModels"
  >
> {
  readonly id: string;
  /** Name in the settings UI. Default: the ID. */
  readonly label?: string;
  generateText: ModelProviderAdapter["generateText"];
  streamText: ModelProviderAdapter["streamText"];
  generateObject?: ModelProviderAdapter["generateObject"];
}
