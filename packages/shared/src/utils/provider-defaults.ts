export type BuiltinProviderProtocol =
  | "openai-chat-v1"
  | "openai-responses-v1"
  | "anthropic-messages-v1"
  | "typesafe-systemone-v1"
  | "openrouter-decisions-v1"
  | "vercel-evaluation-v4";

export interface BuiltinProviderConnection {
  readonly baseUrl: string;
  readonly protocol: BuiltinProviderProtocol;
  /** Suggested evaluation wire when configuring a model in the settings UI. */
  readonly evaluationProtocol?: BuiltinProviderProtocol;
}

/** Canonical public endpoints used when a first-run profile omits baseUrl. */
export const BUILTIN_PROVIDER_CONNECTIONS = {
  openrouter: {
    baseUrl: "https://openrouter.ai/api/v1",
    protocol: "openai-chat-v1",
    evaluationProtocol: "openrouter-decisions-v1",
  },
  vercel: {
    baseUrl: "https://ai-gateway.vercel.sh/v1",
    protocol: "openai-chat-v1",
    evaluationProtocol: "vercel-evaluation-v4",
  },
  typesafe: {
    baseUrl: "https://api.typesafe.ai/v1",
    protocol: "typesafe-systemone-v1",
    evaluationProtocol: "typesafe-systemone-v1",
  },
  deepseek: {
    baseUrl: "https://api.deepseek.com",
    protocol: "openai-chat-v1",
  },
  openai: {
    baseUrl: "https://api.openai.com/v1",
    protocol: "openai-chat-v1",
  },
  anthropic: {
    baseUrl: "https://api.anthropic.com",
    protocol: "anthropic-messages-v1",
  },
  dashscope: {
    baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    protocol: "openai-chat-v1",
  },
} as const satisfies Record<string, BuiltinProviderConnection>;

export function getBuiltinProviderConnection(
  providerId: string,
): BuiltinProviderConnection | undefined {
  return (
    BUILTIN_PROVIDER_CONNECTIONS as Record<
      string,
      BuiltinProviderConnection | undefined
    >
  )[providerId.trim().toLowerCase()];
}
