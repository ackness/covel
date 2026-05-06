import type { ModelProviderAdapter } from "./adapters/adapter.js";
import { createOpenAiChatAdapter } from "./adapters/openai-chat.js";
import { createOpenAiResponsesAdapter } from "./adapters/openai-responses.js";
import { createAnthropicMessagesAdapter } from "./adapters/anthropic-messages.js";
import type {
	CacheStrategy,
	OperationMode,
	ProviderConfig,
	ProviderDefaults,
	ProviderLifecycleHook,
	ProviderProtocol,
} from "./types.js";

/**
 * Resolve the default prompt-cache strategy for a given provider protocol.
 *
 * §A15 of the improvement plan: Anthropic requires explicit `cache_control`
 * markers, OpenAI-family APIs auto-cache on prefix match, and anything
 * else falls through to `none`. Individual callers can override the
 * chosen strategy by setting `ProviderConfig.cacheStrategy` explicitly
 * on the registered defaults or protocol route.
 */
function defaultCacheStrategyFor(protocol: ProviderProtocol): CacheStrategy {
	switch (protocol) {
		case "anthropic-messages-v1":
			return "anthropic-explicit";
		case "openai-chat-v1":
		case "openai-responses-v1":
			return "auto-prefix";
		default:
			return "none";
	}
}

interface ProtocolRoute {
	adapter?: ModelProviderAdapter;
	defaults?: ProviderConfig;
}

interface ProviderRegistration {
	adapter?: ModelProviderAdapter;
	defaults?: ProviderConfig;
	protocols?: Partial<Record<ProviderProtocol, ProtocolRoute>>;
	hooks?: ProviderLifecycleHook[];
}

export interface ProviderResolution {
	adapter: ModelProviderAdapter;
	config: ProviderConfig;
	protocol: ProviderProtocol;
	hooks: ProviderLifecycleHook[];
}

/**
 * Create a provider registry that resolves provider names to adapters.
 *
 * Accepts both programmatic registrations and TOML-derived provider defaults.
 */
export function createProviderRegistry(options?: {
	providers?: Record<string, ProviderRegistration>;
	providerDefaults?: Record<string, ProviderDefaults>;
}) {
	const providers = new Map<string, ProviderRegistration>();

	// Register programmatic providers
	if (options?.providers) {
		for (const [name, entry] of Object.entries(options.providers)) {
			providers.set(name, entry);
		}
	}

	// Merge TOML provider defaults
	if (options?.providerDefaults) {
		for (const [name, defaults] of Object.entries(options.providerDefaults)) {
			const existing = providers.get(name);
			if (existing) {
				providers.set(name, {
					...existing,
					defaults: { ...defaults, ...existing.defaults },
				});
			} else {
				providers.set(name, { defaults });
			}
		}
	}

	function resolve(
		target: {
			provider: string;
			baseUrl?: string;
			protocol?: ProviderProtocol;
		},
		opts: { mode: OperationMode } = { mode: "text" },
	): ProviderResolution {
		const registered = providers.get(target.provider);
		if (!registered) {
			throw new Error(
				`Provider registry: provider "${target.provider}" is not registered.`,
			);
		}

		const protocol = resolveProtocol(target);
		const protocolRoute = registered.protocols?.[protocol];
		const adapter =
			protocolRoute?.adapter ?? registered.adapter ?? builtinAdapter(protocol);

		if (!adapter) {
			throw new Error(
				`Provider registry: protocol "${protocol}" not supported for "${target.provider}".`,
			);
		}

		// Prompt cache strategy (S2-T3): the provider-registered defaults take
		// precedence so tests and specific deployments can override; otherwise
		// we fall back to the protocol-wide default. An explicit `undefined`
		// in the merged config is replaced with the protocol default so the
		// adapter never needs to probe protocol identity itself.
		const mergedConfig: ProviderConfig = {
			...registered.defaults,
			...protocolRoute?.defaults,
			...(target.baseUrl ? { baseUrl: target.baseUrl } : {}),
		};
		if (mergedConfig.cacheStrategy === undefined) {
			mergedConfig.cacheStrategy = defaultCacheStrategyFor(protocol);
		}

		return {
			adapter,
			config: mergedConfig,
			protocol,
			hooks: [...(registered.hooks ?? [])],
		};
	}

	/**
	 * Inject runtime API keys into provider configs.
	 * Returns a new resolution with the key merged.
	 */
	function withApiKeys(
		resolution: ProviderResolution,
		apiKeys: Record<string, string>,
		providerName: string,
	): ProviderResolution {
		const key = apiKeys[providerName];
		if (!key) return resolution;

		return {
			...resolution,
			config: { ...resolution.config, apiKey: key },
		};
	}

	/**
	 * Register (or overwrite) a provider at runtime. Used by transient
	 * flows such as the provider-ping endpoint that accepts custom
	 * providers from the client on a per-request basis.
	 */
	function addProvider(name: string, defaults: ProviderDefaults): void {
		const existing = providers.get(name);
		if (existing) {
			providers.set(name, {
				...existing,
				defaults: { ...defaults, ...existing.defaults },
			});
		} else {
			providers.set(name, { defaults });
		}
	}

	/** Remove a provider by name. */
	function removeProvider(name: string): void {
		providers.delete(name);
	}

	/** Check whether a provider is registered. */
	function hasProvider(name: string): boolean {
		return providers.has(name);
	}

	return { resolve, withApiKeys, addProvider, removeProvider, hasProvider };
}

function resolveProtocol(target: {
	provider: string;
	protocol?: ProviderProtocol;
}): ProviderProtocol {
	if (target.protocol) return target.protocol;
	if (target.provider === "anthropic") return "anthropic-messages-v1";
	return "openai-chat-v1";
}

function builtinAdapter(
	protocol: ProviderProtocol,
): ModelProviderAdapter | null {
	switch (protocol) {
		case "openai-chat-v1":
			return createOpenAiChatAdapter();
		case "openai-responses-v1":
			return createOpenAiResponsesAdapter();
		case "anthropic-messages-v1":
			return createAnthropicMessagesAdapter();
		default:
			return null;
	}
}
