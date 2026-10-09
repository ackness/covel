import type { BuiltinProviderProtocol } from "../provider-protocols.js";

export interface BuiltinProviderConnection {
  /** Product name shown in the settings UI; not translated. */
  readonly label: string;
  readonly baseUrl: string;
  readonly protocol: BuiltinProviderProtocol;
  /** Suggested evaluation wire when configuring a model in the settings UI. */
  readonly evaluationProtocol?: BuiltinProviderProtocol;
  /**
   * A service on the machine that runs the server, at its default port. It
   * needs no API key.
   */
  readonly local?: true;
}

/**
 * Providers a player can pick by name: the canonical public endpoint and the
 * protocol it speaks. A configuration that names one of them may omit
 * `baseUrl` and `protocol`. A server key attaches only to the origin given
 * here. Adding a provider that speaks an existing protocol is one entry.
 *
 * A local service on another port, or one that offers several protocols on
 * one port, is a custom provider with its own `baseUrl` and `protocol`.
 */
export const BUILTIN_PROVIDER_CONNECTIONS = {
  openrouter: {
    label: "OpenRouter",
    baseUrl: "https://openrouter.ai/api/v1",
    protocol: "openai-chat-v1",
    evaluationProtocol: "openrouter-decisions-v1",
  },
  vercel: {
    label: "Vercel AI Gateway",
    baseUrl: "https://ai-gateway.vercel.sh/v1",
    protocol: "openai-chat-v1",
    evaluationProtocol: "vercel-evaluation-v4",
  },
  typesafe: {
    label: "TypeSafe",
    baseUrl: "https://api.typesafe.ai/v1",
    protocol: "typesafe-systemone-v1",
    evaluationProtocol: "typesafe-systemone-v1",
  },
  deepseek: {
    label: "DeepSeek",
    baseUrl: "https://api.deepseek.com",
    protocol: "openai-chat-v1",
  },
  openai: {
    label: "OpenAI",
    baseUrl: "https://api.openai.com/v1",
    protocol: "openai-chat-v1",
  },
  anthropic: {
    label: "Anthropic",
    baseUrl: "https://api.anthropic.com",
    protocol: "anthropic-messages-v1",
  },
  google: {
    label: "Google Gemini",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta",
    protocol: "google-generative-ai-v1",
  },
  dashscope: {
    label: "Alibaba DashScope (Qwen)",
    baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    protocol: "openai-chat-v1",
  },
  xai: {
    label: "xAI",
    baseUrl: "https://api.x.ai/v1",
    protocol: "openai-chat-v1",
  },
  mistral: {
    label: "Mistral AI",
    baseUrl: "https://api.mistral.ai/v1",
    protocol: "openai-chat-v1",
  },
  groq: {
    label: "Groq",
    baseUrl: "https://api.groq.com/openai/v1",
    protocol: "openai-chat-v1",
  },
  together: {
    label: "Together AI",
    baseUrl: "https://api.together.xyz/v1",
    protocol: "openai-chat-v1",
  },
  fireworks: {
    label: "Fireworks AI",
    baseUrl: "https://api.fireworks.ai/inference/v1",
    protocol: "openai-chat-v1",
  },
  moonshot: {
    label: "Moonshot AI (Kimi)",
    baseUrl: "https://api.moonshot.cn/v1",
    protocol: "openai-chat-v1",
  },
  zhipu: {
    label: "Zhipu AI (GLM)",
    baseUrl: "https://open.bigmodel.cn/api/paas/v4",
    protocol: "openai-chat-v1",
  },
  siliconflow: {
    label: "SiliconFlow",
    baseUrl: "https://api.siliconflow.cn/v1",
    protocol: "openai-chat-v1",
  },
  volcengine: {
    label: "Volcengine Ark (Doubao)",
    baseUrl: "https://ark.cn-beijing.volces.com/api/v3",
    protocol: "openai-chat-v1",
  },
  ollama: {
    label: "Ollama",
    baseUrl: "http://localhost:11434/v1",
    protocol: "openai-chat-v1",
    local: true,
  },
  lmstudio: {
    label: "LM Studio",
    baseUrl: "http://localhost:1234/v1",
    protocol: "openai-chat-v1",
    local: true,
  },
  llamacpp: {
    label: "llama.cpp server",
    baseUrl: "http://localhost:8080/v1",
    protocol: "openai-chat-v1",
    local: true,
  },
  vllm: {
    label: "vLLM",
    baseUrl: "http://localhost:8000/v1",
    protocol: "openai-chat-v1",
    local: true,
  },
  litellm: {
    label: "LiteLLM Proxy",
    baseUrl: "http://localhost:4000/v1",
    protocol: "openai-chat-v1",
    local: true,
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

/** The built-in providers by product name, for a picker. */
export function listBuiltinProviderConnections(): Array<
  BuiltinProviderConnection & { readonly id: string }
> {
  return Object.entries(BUILTIN_PROVIDER_CONNECTIONS)
    .map(([id, connection]) => ({ id, ...connection }))
    .sort((left, right) => left.label.localeCompare(right.label));
}

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * True for an endpoint on the machine that runs the server. Such a service
 * usually takes no API key, so a model on it is ready without one.
 */
export function isLoopbackBaseUrl(baseUrl: string | undefined): boolean {
  if (!baseUrl) return false;
  try {
    return LOOPBACK_HOSTS.has(new URL(baseUrl).hostname.toLowerCase());
  } catch {
    return false;
  }
}
