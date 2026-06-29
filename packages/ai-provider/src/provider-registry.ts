import type { ModelProviderAdapter } from "./adapters/adapter.js";
import {
  assertProtocolRegistryComplete,
  getProtocolDefinition,
} from "./protocol-registry.js";
import type {
  CacheStrategy,
  OperationMode,
  ProviderConfig,
  ProviderDefaults,
  ProviderLifecycleHook,
  ProviderProtocol,
} from "./types.js";

// Fail fast at module load if a known protocol lost its registration.
assertProtocolRegistryComplete();

/**
 * Provider-name → default protocol when the target doesn't pin one.
 *
 * Data table replacing the old `if (provider === "anthropic")` special
 * case in `resolveProtocol`. OpenAI-compatible providers need no entry —
 * they fall through to {@link FALLBACK_PROTOCOL}. A genuinely new
 * native-wire provider adds one line here.
 */
const PROVIDER_PROTOCOL_DEFAULTS: Record<string, ProviderProtocol> = {
  anthropic: "anthropic-messages-v1",
};

/** Protocol assumed for any provider without a {@link PROVIDER_PROTOCOL_DEFAULTS} entry. */
const FALLBACK_PROTOCOL: ProviderProtocol = "openai-chat-v1";

/**
 * Resolve the default prompt-cache strategy for a given provider protocol.
 *
 * §A15 of the improvement plan: each protocol declares its own strategy in
 * the protocol registry (Anthropic → explicit `cache_control` markers,
 * OpenAI-family → `auto-prefix`); an unregistered protocol falls through to
 * `none`. Individual callers can still override the chosen strategy by
 * setting `ProviderConfig.cacheStrategy` explicitly on the registered
 * defaults or protocol route.
 */
function defaultCacheStrategyFor(protocol: ProviderProtocol): CacheStrategy {
  return getProtocolDefinition(protocol)?.cacheStrategy ?? "none";
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

  function populate(opts?: {
    providers?: Record<string, ProviderRegistration>;
    providerDefaults?: Record<string, ProviderDefaults>;
  }): void {
    // Register programmatic providers
    if (opts?.providers) {
      for (const [name, entry] of Object.entries(opts.providers)) {
        providers.set(name, entry);
      }
    }

    // Merge TOML provider defaults
    if (opts?.providerDefaults) {
      for (const [name, defaults] of Object.entries(opts.providerDefaults)) {
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
  }

  /**
   * Replace all registrations with a fresh config — used by llm.toml
   * hot-reload. Clears every provider (programmatic + TOML-derived) and
   * repopulates from `opts`, so a provider removed from llm.toml stops
   * resolving without rebuilding the registry object (the gateway holds
   * this registry by reference and reads it live).
   */
  function reconfigure(opts?: {
    providers?: Record<string, ProviderRegistration>;
    providerDefaults?: Record<string, ProviderDefaults>;
  }): void {
    providers.clear();
    populate(opts);
  }

  populate(options);

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

  return {
    resolve,
    withApiKeys,
    addProvider,
    removeProvider,
    hasProvider,
    reconfigure,
  };
}

function resolveProtocol(target: {
  provider: string;
  protocol?: ProviderProtocol;
}): ProviderProtocol {
  if (target.protocol) return target.protocol;
  return PROVIDER_PROTOCOL_DEFAULTS[target.provider] ?? FALLBACK_PROTOCOL;
}

function builtinAdapter(
  protocol: ProviderProtocol,
): ModelProviderAdapter | null {
  return getProtocolDefinition(protocol)?.createAdapter() ?? null;
}
