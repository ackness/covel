export type BuiltinProviderProtocol =
  "openai-chat-v1" | "openai-responses-v1" | "anthropic-messages-v1";

export interface BuiltinProviderConnection {
  readonly baseUrl: string;
  readonly protocol: BuiltinProviderProtocol;
}

/** Canonical public endpoints used when a first-run profile omits baseUrl. */
export const BUILTIN_PROVIDER_CONNECTIONS = {
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
