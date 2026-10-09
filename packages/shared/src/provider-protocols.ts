import type { PluginProviderProtocol } from "@covel/plugin-handlers-utils";

/** What a model on a protocol produces when nothing more is known of it. */
export type ProviderProtocolOutput = "text" | "evaluation";

export interface ProviderProtocolDescriptor {
  readonly id: string;
  /** Product name shown in the settings UI; not translated. */
  readonly label: string;
  readonly output: ProviderProtocolOutput;
}

/**
 * Every wire protocol the framework has a built-in adapter for. This is the
 * only list: the config schema, the request validators, the settings UI and
 * the provider package derive their protocol IDs from it.
 *
 * An OpenAI-compatible provider is not a protocol. It speaks
 * `openai-chat-v1` and belongs in `BUILTIN_PROVIDER_CONNECTIONS`.
 */
export const PROVIDER_PROTOCOL_DESCRIPTORS = [
  { id: "openai-chat-v1", label: "OpenAI Chat", output: "text" },
  { id: "openai-responses-v1", label: "OpenAI Responses", output: "text" },
  { id: "anthropic-messages-v1", label: "Anthropic Messages", output: "text" },
  { id: "google-generative-ai-v1", label: "Google Gemini", output: "text" },
  {
    id: "typesafe-systemone-v1",
    label: "TypeSafe System One",
    output: "evaluation",
  },
  {
    id: "openrouter-decisions-v1",
    label: "OpenRouter Decisions",
    output: "evaluation",
  },
  {
    id: "vercel-evaluation-v4",
    label: "Vercel AI Gateway",
    output: "evaluation",
  },
] as const satisfies readonly ProviderProtocolDescriptor[];

export type BuiltinProviderProtocol =
  (typeof PROVIDER_PROTOCOL_DESCRIPTORS)[number]["id"];

export const BUILTIN_PROVIDER_PROTOCOLS = PROVIDER_PROTOCOL_DESCRIPTORS.map(
  (descriptor) => descriptor.id,
) as [BuiltinProviderProtocol, ...BuiltinProviderProtocol[]];

// The plugin SDK cannot import this package and keeps a copy of the list:
// `tsc` fails on the line below when the copy differs.
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
const sdkListInStep: Same<PluginProviderProtocol, BuiltinProviderProtocol> =
  true;
void sdkListInStep;

/** The protocol of a provider that states none and is not built in. */
export const DEFAULT_PROVIDER_PROTOCOL =
  "openai-chat-v1" satisfies BuiltinProviderProtocol;

export function getProviderProtocolDescriptor(
  protocol: string | undefined,
): ProviderProtocolDescriptor | undefined {
  return PROVIDER_PROTOCOL_DESCRIPTORS.find(
    (descriptor) => descriptor.id === protocol,
  );
}

export function isBuiltinProviderProtocol(
  protocol: string | undefined,
): protocol is BuiltinProviderProtocol {
  return getProviderProtocolDescriptor(protocol) !== undefined;
}

/** True for a protocol whose built-in adapter generates text. */
export function isBuiltinTextProtocol(protocol: string | undefined): boolean {
  return getProviderProtocolDescriptor(protocol)?.output === "text";
}

/** `<pluginId>/<wireId>`: a text protocol a plugin registers. */
const PLUGIN_PROTOCOL_ID = /^[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*$/i;

/**
 * True for a built-in protocol and for the ID form of a plugin's text
 * protocol. Whether that plugin is loaded is known only when a call resolves.
 */
export function isProviderProtocolId(protocol: string | undefined): boolean {
  return (
    isBuiltinProviderProtocol(protocol) ||
    (protocol !== undefined && PLUGIN_PROTOCOL_ID.test(protocol))
  );
}
