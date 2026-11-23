/**
 * Instance-scoped Provider Source host (`provider.source@1`).
 *
 * Bridges plugin-registered `PluginProviderSource` objects into
 * `@covel/ai-provider`'s `ProviderSourceResolver`, enforcing:
 * - L1/L2/L3 `plugin.instanceScope` + `plugin.providerSource` permissions at
 *   every resolve/refresh/list/usage call.
 * - Declarative manifest validation and strict HTTPS/loopback + same-origin
 *   locking against the declared manifest `baseUrl`.
 * - SecretVault idle check on startup (`warmStatus`) so unauthenticated plugins
 *   remain dormant without activating or touching secrets.
 * - Generation-aware single-flight `refresh()` deduplication so N concurrent 401s
 *   for one `(sourceId, accountId)` trigger at most one refresh exchange.
 */

import {
  AiProviderError,
  hasSameOrigin,
  type ProviderSourceAttemptContext,
  type ProviderSourceInspectResult,
  type ProviderSourceResolver,
} from "@covel/ai-provider";
import {
  compareText,
  DEFAULT_PROVIDER_PROTOCOL,
  FRAMEWORK_PLUGIN_ID,
  isProviderProtocolId,
} from "@covel/shared";
import {
  isAllowedProviderSourceBaseUrl,
  parseQualifiedProviderSourceId,
  providerSourceIdSchema,
  providerSourceSupportsMode,
  qualifiedProviderSourceId,
  type ProviderSourceAccountSummary,
  type ProviderSourceContribution,
  type ProviderSourceSummary,
  type ProviderSourceUsageSummary,
} from "@covel/shared/platform";
import type { PluginRegistry, PluginRegistryEntry } from "@covel/plugin-loader";
import type {
  PluginProviderSource,
  PluginProviderSourceContext,
  PluginProviderSourceResolved,
} from "@covel/runtime";
import type { DataStore } from "@covel/store";
import type { HostProfile } from "../../../host-profile.js";
import type { PermissionService } from "../../../trust/permission-service.js";
import type { SecretVault } from "../../../trust/secret-vault.js";
import type { TrustedSourceService } from "../../../trust/trusted-source-service.js";
import { withCallSignal } from "./entry-http.js";
import {
  checkInstancePluginAllowed,
  isInstancePluginAllowed,
  isPluginCapabilityEffectivelyAllowed,
  type InstancePluginRegistry,
} from "./instance-plugins.js";
import {
  buildPluginInstanceSurface,
  packageHttpPermissions,
  pickPluginInstanceSurfaceFields,
} from "./plugin-entry-api.js";

const DEFAULT_ACCOUNT_KEY = "__default__";
const DEFAULT_CALL_TIMEOUT_MS = 15_000;
const REFRESH_TIMEOUT_MS = 25_000;

export class ProviderSourceHostError extends Error {
  constructor(
    readonly status: 400 | 403 | 404 | 500 | 502,
    readonly code: string,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "ProviderSourceHostError";
  }
}

export interface ProviderSourceHostDeps {
  readonly registry: PluginRegistry;
  readonly store: DataStore;
  readonly hostId?: string;
  readonly secretVault?: SecretVault;
  readonly getPermissionService: () => PermissionService | undefined;
  readonly getTrustedSources: () => TrustedSourceService | undefined;
  readonly getInstancePlugins: () => InstancePluginRegistry | undefined;
}

export interface ProviderSourceHost {
  register(pluginId: string, source: PluginProviderSource): () => void;
  replacePlugin<T>(pluginId: string, fn: () => T): T;
  invalidatePlugin(pluginId: string): void;
  warmStatus(): Promise<void>;
  refreshPluginStatus(pluginId: string): Promise<void>;
  listSummaries(
    hostProfile?: HostProfile,
  ): Promise<readonly ProviderSourceSummary[]>;
  listModels(args: {
    readonly sourceId: string;
    readonly accountId?: string;
    readonly signal?: AbortSignal;
    readonly hostProfile?: HostProfile;
  }): Promise<readonly string[]>;
  getUsage(args: {
    readonly sourceId: string;
    readonly accountId?: string;
    readonly signal?: AbortSignal;
    readonly hostProfile?: HostProfile;
  }): Promise<ProviderSourceUsageSummary | null>;
  readonly resolver: ProviderSourceResolver;
}

interface RegisteredProviderSource {
  readonly pluginId: string;
  readonly sourceId: string;
  readonly qualifiedId: string;
  readonly source: PluginProviderSource;
}

interface DeclaredSourceLookup {
  readonly pluginId: string;
  readonly sourceId: string;
  readonly qualifiedId: string;
  readonly entry: PluginRegistryEntry;
  readonly decl: ProviderSourceContribution;
}

interface CachedSourceStatus {
  readonly ready: boolean;
  readonly reason?: string;
  readonly accounts: readonly ProviderSourceAccountSummary[];
}

function registryKey(pluginId: string, sourceId: string): string {
  return `${pluginId}\0${sourceId}`;
}

function generationKey(qualifiedId: string, accountId?: string): string {
  return `${qualifiedId}::${accountId ?? DEFAULT_ACCOUNT_KEY}`;
}

function buildStatusTimeoutSignal(
  callerSignal?: AbortSignal,
  timeoutMs = DEFAULT_CALL_TIMEOUT_MS,
): {
  readonly signal: AbortSignal;
  readonly dispose: () => void;
} {
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort(new Error("provider source request timed out"));
  }, timeoutMs);
  timer.unref?.();
  const onCallerAbort = () => {
    controller.abort(callerSignal?.reason);
  };
  if (callerSignal) {
    if (callerSignal.aborted) {
      controller.abort(callerSignal.reason);
    } else {
      callerSignal.addEventListener("abort", onCallerAbort, { once: true });
    }
  }
  return {
    signal: controller.signal,
    dispose: () => {
      clearTimeout(timer);
      callerSignal?.removeEventListener("abort", onCallerAbort);
    },
  };
}

function deriveStatusFromAccounts(
  accounts: readonly ProviderSourceAccountSummary[],
  accountId?: string,
): { readonly ready: boolean; readonly reason?: string } {
  if (accountId !== undefined) {
    const match = accounts.find((acc) => acc.id === accountId);
    if (!match) {
      return { ready: false, reason: "account_not_found" };
    }
    return match.status === "ready"
      ? { ready: true }
      : { ready: false, reason: match.status };
  }
  if (accounts.some((acc) => acc.status === "ready")) {
    return { ready: true };
  }
  if (accounts.length === 0) {
    return { ready: false, reason: "not_signed_in" };
  }
  const preferred = accounts.find((acc) => acc.isDefault) ?? accounts[0]!;
  return { ready: false, reason: preferred.status };
}

function validateHeadersObject(
  headers: unknown,
  qualifiedId: string,
): Readonly<Record<string, string>> {
  if (!headers || typeof headers !== "object" || Array.isArray(headers)) {
    throw new AiProviderError({
      code: "CONFIG_ERROR",
      provider: qualifiedId,
      message: `Provider source "${qualifiedId}" returned invalid headers`,
      retriable: false,
    });
  }
  const normalized: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (typeof value !== "string") {
      throw new AiProviderError({
        code: "CONFIG_ERROR",
        provider: qualifiedId,
        message: `Provider source "${qualifiedId}" returned non-string header "${key}"`,
        retriable: false,
      });
    }
    normalized[key] = value;
  }
  return normalized;
}

export function createProviderSourceHost(
  deps: ProviderSourceHostDeps,
): ProviderSourceHost {
  const { registry, store, hostId, secretVault } = deps;
  const entries = new Map<string, RegisteredProviderSource>();
  const statusCache = new Map<string, CachedSourceStatus>();
  const latestGenerations = new Map<string, number>();
  const inFlightRefreshes = new Map<
    string,
    Promise<ProviderSourceAttemptContext | null>
  >();

  const lookupDeclared = (qualifiedId: string): DeclaredSourceLookup | null => {
    const parsed = parseQualifiedProviderSourceId(qualifiedId);
    if (!parsed) return null;
    const entry = registry.getCurrent(parsed.pluginId);
    const decl =
      entry?.packageManifest?.plugin.contributes?.providerSources?.find(
        (item) => item.id === parsed.sourceId,
      );
    if (!entry || !decl) return null;
    return {
      pluginId: parsed.pluginId,
      sourceId: parsed.sourceId,
      qualifiedId,
      entry,
      decl,
    };
  };

  const isProviderSourceCeilingEnabled = (
    permissionService: PermissionService | undefined,
    hostProfile?: HostProfile,
  ): permissionService is PermissionService =>
    permissionService !== undefined &&
    hostProfile?.capabilities["plugin.providerSource"] !== "disabled" &&
    permissionService.snapshot(hostProfile).capabilities[
      "plugin.providerSource"
    ] !== "disabled";

  const hasSourceCapability = (
    permissionService: PermissionService,
    pluginId: string,
  ): boolean =>
    isPluginCapabilityEffectivelyAllowed(
      permissionService,
      registry,
      "plugin.providerSource",
      pluginId,
    );

  const evaluateGateSync = (
    pluginId: string,
    hostProfile?: HostProfile,
  ): { readonly allowed: boolean; readonly reason?: string } => {
    const permissionService = deps.getPermissionService();
    if (!isProviderSourceCeilingEnabled(permissionService, hostProfile)) {
      return { allowed: false, reason: "capability_denied" };
    }
    if (
      !isInstancePluginAllowed(
        {
          registry,
          permissionService,
          trustedSources: deps.getTrustedSources(),
        },
        pluginId,
      ) ||
      !hasSourceCapability(permissionService, pluginId)
    ) {
      return { allowed: false, reason: "capability_denied" };
    }
    return { allowed: true };
  };

  const evaluateGateAsync = async (
    pluginId: string,
    hostProfile?: HostProfile,
  ): Promise<{ readonly allowed: boolean; readonly reason?: string }> => {
    const permissionService = deps.getPermissionService();
    if (!isProviderSourceCeilingEnabled(permissionService, hostProfile)) {
      return { allowed: false, reason: "capability_denied" };
    }
    const instanceAllowed = await checkInstancePluginAllowed(
      {
        registry,
        permissionService,
        trustedSources: deps.getTrustedSources(),
      },
      pluginId,
    );
    if (!instanceAllowed || !hasSourceCapability(permissionService, pluginId)) {
      return { allowed: false, reason: "capability_denied" };
    }
    return { allowed: true };
  };

  const buildContext = (
    declared: DeclaredSourceLookup,
    signal: AbortSignal,
  ): PluginProviderSourceContext => {
    const surface = buildPluginInstanceSurface({
      pluginId: declared.pluginId,
      pluginRegistry: registry,
      store,
      hostId,
      secretVault,
      getPermissionService: deps.getPermissionService,
      httpPermissions: packageHttpPermissions(declared.entry),
    });
    return {
      signal,
      pluginId: declared.pluginId,
      sourceId: declared.sourceId,
      ...pickPluginInstanceSurfaceFields(surface),
      http: withCallSignal(surface.http, signal),
    };
  };

  const markSourceNeedsReauth = (
    qualifiedId: string,
    accountId?: string,
  ): void => {
    const prev = statusCache.get(qualifiedId);
    if (accountId && prev && prev.accounts.length > 0) {
      const updatedAccounts = prev.accounts.map((acc) =>
        acc.id === accountId
          ? { ...acc, status: "needs_reauth" as const }
          : acc,
      );
      const derived = deriveStatusFromAccounts(updatedAccounts);
      statusCache.set(qualifiedId, {
        ready: derived.ready,
        ...(derived.reason ? { reason: derived.reason } : {}),
        accounts: updatedAccounts,
      });
      return;
    }
    statusCache.set(qualifiedId, {
      ready: false,
      reason: "needs_reauth",
      accounts: prev?.accounts ?? [],
    });
  };

  const ensureActivatedSource = async (
    declared: DeclaredSourceLookup,
  ): Promise<RegisteredProviderSource> => {
    const key = registryKey(declared.pluginId, declared.sourceId);
    const existing = entries.get(key);
    if (existing) return existing;

    const instancePlugins = deps.getInstancePlugins();
    if (instancePlugins && !instancePlugins.isActivated(declared.pluginId)) {
      await instancePlugins.activate(declared.pluginId);
    }

    const afterActivate = entries.get(key);
    if (!afterActivate) {
      throw new ProviderSourceHostError(
        500,
        "provider_source_unregistered",
        `Provider source "${declared.qualifiedId}" is declared in plugin manifest but not registered by server entry`,
      );
    }
    return afterActivate;
  };

  const clearSourceState = (qualifiedId: string): void => {
    statusCache.delete(qualifiedId);
    const prefix = `${qualifiedId}::`;
    for (const key of latestGenerations.keys()) {
      if (key.startsWith(prefix)) {
        latestGenerations.delete(key);
      }
    }
  };

  const buildAttemptContext = (
    declared: DeclaredSourceLookup,
    registered: RegisteredProviderSource,
    resolved: PluginProviderSourceResolved,
    requestedAccountId: string | undefined,
    assignedGeneration: number,
  ): ProviderSourceAttemptContext => {
    const declaredBaseUrl = declared.decl.baseUrl;
    const declaredProtocol =
      declared.decl.protocol ?? DEFAULT_PROVIDER_PROTOCOL;
    const resolvedBaseUrl = resolved.baseUrl ?? declaredBaseUrl;

    if (
      resolved.protocol !== undefined &&
      !isProviderProtocolId(resolved.protocol)
    ) {
      throw new AiProviderError({
        code: "CONFIG_ERROR",
        provider: declared.qualifiedId,
        message: `Provider source "${declared.qualifiedId}" returned unknown protocol "${resolved.protocol}"`,
        retriable: false,
      });
    }
    if (!isAllowedProviderSourceBaseUrl(resolvedBaseUrl)) {
      throw new AiProviderError({
        code: "CONFIG_ERROR",
        provider: declared.qualifiedId,
        message: `Provider source "${declared.qualifiedId}" returned disallowed baseUrl`,
        retriable: false,
      });
    }
    if (!hasSameOrigin(resolvedBaseUrl, declaredBaseUrl)) {
      throw new AiProviderError({
        code: "CONFIG_ERROR",
        provider: declared.qualifiedId,
        message: `Provider source "${declared.qualifiedId}" baseUrl origin does not match manifest declared baseUrl`,
        retriable: false,
      });
    }

    const headers = validateHeadersObject(
      resolved.headers,
      declared.qualifiedId,
    );
    const effectiveAccountId = resolved.accountId ?? requestedAccountId;

    const genKeyRequested = generationKey(
      declared.qualifiedId,
      requestedAccountId,
    );
    latestGenerations.set(
      genKeyRequested,
      Math.max(latestGenerations.get(genKeyRequested) ?? 0, assignedGeneration),
    );
    if (effectiveAccountId !== requestedAccountId) {
      const genKeyEffective = generationKey(
        declared.qualifiedId,
        effectiveAccountId,
      );
      latestGenerations.set(
        genKeyEffective,
        Math.max(
          latestGenerations.get(genKeyEffective) ?? 0,
          assignedGeneration,
        ),
      );
    }

    const existingCached = statusCache.get(declared.qualifiedId);
    const updatedAccounts = existingCached?.accounts.map((acc) =>
      effectiveAccountId && acc.id === effectiveAccountId
        ? { ...acc, status: "ready" as const }
        : acc,
    );
    statusCache.set(declared.qualifiedId, {
      ready: true,
      accounts: updatedAccounts ?? [],
    });

    const classifyError = registered.source.classifyError
      ? (error: {
          readonly statusCode?: number;
          readonly body?: unknown;
          readonly message: string;
        }) => registered.source.classifyError?.(error) ?? null
      : undefined;

    return {
      sourceId: declared.qualifiedId,
      declaredBaseUrl,
      declaredProtocol,
      ...(effectiveAccountId ? { accountId: effectiveAccountId } : {}),
      baseUrl: resolvedBaseUrl,
      protocol: resolved.protocol ?? declaredProtocol,
      headers,
      credentialGeneration: assignedGeneration,
      ...(resolved.requestShape ? { requestShape: resolved.requestShape } : {}),
      ...(classifyError ? { classifyError } : {}),
    };
  };

  const inspectDeclaredStatus = async (
    declared: DeclaredSourceLookup,
    opts?: {
      readonly allowActivation?: boolean;
      readonly signal?: AbortSignal;
      readonly hostProfile?: HostProfile;
    },
  ): Promise<CachedSourceStatus> => {
    const gate = await evaluateGateAsync(declared.pluginId, opts?.hostProfile);
    if (!gate.allowed) {
      const denied: CachedSourceStatus = {
        ready: false,
        reason: gate.reason ?? "capability_denied",
        accounts: [],
      };
      statusCache.set(declared.qualifiedId, denied);
      return denied;
    }

    const instancePlugins = deps.getInstancePlugins();
    const isActivated =
      instancePlugins?.isActivated(declared.pluginId) ?? false;
    const requiresSecrets =
      declared.entry.packageManifest?.plugin.permissions?.secrets === true;

    if (!isActivated) {
      if (requiresSecrets && secretVault) {
        const secrets = await secretVault.list(declared.pluginId);
        if (secrets.length === 0) {
          const notSignedIn: CachedSourceStatus = {
            ready: false,
            reason: "not_signed_in",
            accounts: [],
          };
          statusCache.set(declared.qualifiedId, notSignedIn);
          return notSignedIn;
        }
        // Signed-in secrets exist: proceed to activate and inspect live account status.
      } else if (opts?.allowActivation === false) {
        const uninitialized: CachedSourceStatus = {
          ready: false,
          reason: requiresSecrets ? "not_signed_in" : "uninitialized",
          accounts: [],
        };
        statusCache.set(declared.qualifiedId, uninitialized);
        return uninitialized;
      }
    }

    let registered: RegisteredProviderSource;
    try {
      registered = await ensureActivatedSource(declared);
    } catch {
      const failed: CachedSourceStatus = {
        ready: false,
        reason: "activation_failed",
        accounts: [],
      };
      statusCache.set(declared.qualifiedId, failed);
      return failed;
    }

    if (registered.source.listAccounts) {
      const timeout = buildStatusTimeoutSignal(opts?.signal);
      try {
        const accounts = await registered.source.listAccounts(
          buildContext(declared, timeout.signal),
        );
        const derived = deriveStatusFromAccounts(accounts);
        const cached: CachedSourceStatus = {
          ready: derived.ready,
          ...(derived.reason ? { reason: derived.reason } : {}),
          accounts,
        };
        statusCache.set(declared.qualifiedId, cached);
        return cached;
      } catch {
        const cached: CachedSourceStatus = {
          ready: false,
          reason: "status_error",
          accounts: [],
        };
        statusCache.set(declared.qualifiedId, cached);
        return cached;
      } finally {
        timeout.dispose();
      }
    }

    if (requiresSecrets && secretVault) {
      const secrets = await secretVault.list(declared.pluginId);
      const cached: CachedSourceStatus =
        secrets.length > 0
          ? { ready: true, accounts: [] }
          : { ready: false, reason: "not_signed_in", accounts: [] };
      statusCache.set(declared.qualifiedId, cached);
      return cached;
    }

    const readyStatus: CachedSourceStatus = { ready: true, accounts: [] };
    statusCache.set(declared.qualifiedId, readyStatus);
    return readyStatus;
  };

  const refreshPluginStatus = async (pluginId: string): Promise<void> => {
    const entry = registry.getCurrent(pluginId);
    const decls =
      entry?.packageManifest?.plugin.contributes?.providerSources ?? [];
    for (const decl of decls) {
      const qualifiedId = qualifiedProviderSourceId(pluginId, decl.id);
      const declared = lookupDeclared(qualifiedId);
      if (!declared) continue;
      await inspectDeclaredStatus(declared, { allowActivation: true });
    }
  };

  const warmStatus = async (): Promise<void> => {
    const entriesList = [...registry.getAll().values()].sort((a, b) =>
      compareText(a.id, b.id),
    );
    for (const entry of entriesList) {
      const decls =
        entry.packageManifest?.plugin.contributes?.providerSources ?? [];
      if (decls.length === 0) continue;
      for (const decl of decls) {
        const qualifiedId = qualifiedProviderSourceId(entry.id, decl.id);
        const declared = lookupDeclared(qualifiedId);
        if (!declared) continue;
        await inspectDeclaredStatus(declared, { allowActivation: false });
      }
    }
  };

  const resolver: ProviderSourceResolver = {
    inspectSync(
      qualifiedId: string,
      accountId?: string,
    ): ProviderSourceInspectResult | null {
      const declared = lookupDeclared(qualifiedId);
      if (!declared) return null;

      const baseInfo = {
        sourceId: declared.qualifiedId,
        ...(accountId ? { accountId } : {}),
        baseUrl: declared.decl.baseUrl,
        protocol: declared.decl.protocol ?? DEFAULT_PROVIDER_PROTOCOL,
        modes: declared.decl.modes ?? (["text"] as const),
      };

      const gate = evaluateGateSync(declared.pluginId);
      if (!gate.allowed) {
        return {
          ...baseInfo,
          ready: false,
          reason: gate.reason ?? "capability_denied",
        };
      }

      const cached = statusCache.get(declared.qualifiedId);
      if (!cached) {
        return {
          ...baseInfo,
          ready: false,
          reason: "uninitialized",
        };
      }

      if (accountId !== undefined && cached.accounts.length > 0) {
        const derived = deriveStatusFromAccounts(cached.accounts, accountId);
        return {
          ...baseInfo,
          ready: derived.ready,
          ...(derived.reason ? { reason: derived.reason } : {}),
        };
      }

      return {
        ...baseInfo,
        ready: cached.ready,
        ...(cached.reason ? { reason: cached.reason } : {}),
      };
    },

    async resolve(request): Promise<ProviderSourceAttemptContext> {
      const configError = (message: string, cause?: unknown) =>
        new AiProviderError({
          code: "CONFIG_ERROR",
          provider: request.sourceId,
          model: request.model,
          message,
          retriable: false,
          ...(cause !== undefined ? { cause } : {}),
        });

      const declared = lookupDeclared(request.sourceId);
      if (!declared) {
        throw configError(`Unknown provider source "${request.sourceId}"`);
      }

      if (!providerSourceSupportsMode(declared.decl.modes, request.mode)) {
        throw configError(
          `Provider source "${request.sourceId}" does not support mode "${request.mode}"`,
        );
      }

      if (
        request.declaredBaseUrl &&
        !hasSameOrigin(request.declaredBaseUrl, declared.decl.baseUrl)
      ) {
        throw configError(
          `Slot baseUrl does not match origin declared by provider source "${request.sourceId}"`,
        );
      }

      const gate = await evaluateGateAsync(declared.pluginId);
      if (!gate.allowed) {
        throw configError(
          `Provider source "${request.sourceId}" is denied by instance permissions`,
        );
      }

      let registered: RegisteredProviderSource;
      try {
        registered = await ensureActivatedSource(declared);
      } catch (error) {
        throw configError(
          error instanceof Error
            ? error.message
            : `Failed to activate provider source "${request.sourceId}"`,
          error,
        );
      }

      const timeout = buildStatusTimeoutSignal(request.signal);
      try {
        const resolved = await registered.source.resolve(
          {
            mode: request.mode,
            model: request.model,
            ...(request.accountId ? { accountId: request.accountId } : {}),
          },
          buildContext(declared, timeout.signal),
        );
        const key = generationKey(declared.qualifiedId, request.accountId);
        const currentGen = latestGenerations.get(key) ?? 1;
        const assignedGeneration = resolved.credentialGeneration ?? currentGen;
        return buildAttemptContext(
          declared,
          registered,
          resolved,
          request.accountId,
          assignedGeneration,
        );
      } catch (error) {
        if (error instanceof AiProviderError) throw error;
        markSourceNeedsReauth(declared.qualifiedId, request.accountId);
        throw configError(
          error instanceof Error
            ? error.message
            : `Provider source "${request.sourceId}" failed to resolve credentials`,
          error,
        );
      } finally {
        timeout.dispose();
      }
    },

    refresh(request): Promise<ProviderSourceAttemptContext | null> {
      const declared = lookupDeclared(request.sourceId);
      if (!declared) return Promise.resolve(null);

      const lockKey = generationKey(declared.qualifiedId, request.accountId);
      const existingFlight = inFlightRefreshes.get(lockKey);
      if (existingFlight) {
        return existingFlight;
      }

      const latest = latestGenerations.get(lockKey) ?? 0;
      if (
        request.failedGeneration !== undefined &&
        latest > request.failedGeneration
      ) {
        return resolver
          .resolve({
            sourceId: request.sourceId,
            ...(request.accountId ? { accountId: request.accountId } : {}),
            mode: declared.decl.modes?.[0] ?? "text",
            model: "",
            signal: request.signal,
          })
          .catch(() => null);
      }

      const flight: {
        promise?: Promise<ProviderSourceAttemptContext | null>;
      } = {};
      flight.promise =
        (async (): Promise<ProviderSourceAttemptContext | null> => {
          const timeout = buildStatusTimeoutSignal(
            undefined,
            REFRESH_TIMEOUT_MS,
          );
          try {
            const gate = await evaluateGateAsync(declared.pluginId);
            if (!gate.allowed) return null;

            const registered = await ensureActivatedSource(declared);
            const refreshFn = registered.source.refresh;
            if (!refreshFn) {
              return null;
            }

            const refreshed = await refreshFn(
              {
                ...(request.accountId ? { accountId: request.accountId } : {}),
                ...(request.failedGeneration !== undefined
                  ? { failedGeneration: request.failedGeneration }
                  : {}),
                statusCode: request.statusCode,
              },
              buildContext(declared, timeout.signal),
            );
            if (!refreshed) {
              markSourceNeedsReauth(declared.qualifiedId);
              return null;
            }
            const baseGen = Math.max(
              latestGenerations.get(lockKey) ?? 0,
              request.failedGeneration ?? 0,
            );
            const nextGeneration =
              refreshed.credentialGeneration !== undefined &&
              refreshed.credentialGeneration > baseGen
                ? refreshed.credentialGeneration
                : baseGen + 1;
            return buildAttemptContext(
              declared,
              registered,
              refreshed,
              request.accountId,
              nextGeneration,
            );
          } catch {
            markSourceNeedsReauth(declared.qualifiedId);
            return null;
          } finally {
            timeout.dispose();
            if (inFlightRefreshes.get(lockKey) === flight.promise) {
              inFlightRefreshes.delete(lockKey);
            }
          }
        })();

      inFlightRefreshes.set(lockKey, flight.promise);
      return flight.promise;
    },
  };

  const runProviderSourceAdminCall = async <TResult>(
    args: {
      readonly sourceId: string;
      readonly signal?: AbortSignal;
      readonly hostProfile?: HostProfile;
    },
    invoke: (ctx: {
      readonly declared: DeclaredSourceLookup;
      readonly registered: RegisteredProviderSource;
      readonly signal: AbortSignal;
    }) => Promise<TResult>,
  ): Promise<TResult> => {
    const declared = lookupDeclared(args.sourceId);
    if (!declared) {
      throw new ProviderSourceHostError(
        404,
        "provider_source_not_found",
        `Provider source "${args.sourceId}" not found`,
      );
    }
    const gate = await evaluateGateAsync(declared.pluginId, args.hostProfile);
    if (!gate.allowed) {
      throw new ProviderSourceHostError(
        403,
        "capability_denied",
        `Provider source "${args.sourceId}" is not permitted`,
      );
    }
    const registered = await ensureActivatedSource(declared);
    const timeout = buildStatusTimeoutSignal(args.signal);
    try {
      return await invoke({ declared, registered, signal: timeout.signal });
    } catch (error) {
      if (error instanceof ProviderSourceHostError) throw error;
      throw new ProviderSourceHostError(
        502,
        "provider_source_error",
        error instanceof Error ? error.message : String(error),
        { cause: error },
      );
    } finally {
      timeout.dispose();
    }
  };

  return {
    register(pluginId: string, source: PluginProviderSource): () => void {
      if (pluginId === FRAMEWORK_PLUGIN_ID) {
        throw new Error(
          `[provider-sources] "${FRAMEWORK_PLUGIN_ID}" is reserved for framework providers`,
        );
      }
      const parsedId = providerSourceIdSchema.safeParse(source?.id);
      if (!parsedId.success) {
        throw new Error(
          parsedId.error.issues.map((issue) => issue.message).join("; "),
        );
      }
      if (typeof source.resolve !== "function") {
        throw new Error(
          `provider source "${source.id}" must implement resolve()`,
        );
      }
      const key = registryKey(pluginId, source.id);
      if (entries.has(key)) {
        throw new Error(
          `provider source "${source.id}" is already registered in plugin "${pluginId}"`,
        );
      }
      const entry: RegisteredProviderSource = {
        pluginId,
        sourceId: source.id,
        qualifiedId: qualifiedProviderSourceId(pluginId, source.id),
        source,
      };
      entries.set(key, entry);
      return () => {
        if (entries.get(key) === entry) {
          entries.delete(key);
          clearSourceState(entry.qualifiedId);
        }
      };
    },

    replacePlugin<T>(pluginId: string, fn: () => T): T {
      const saved: Array<[string, RegisteredProviderSource]> = [];
      for (const [key, entry] of entries) {
        if (entry.pluginId === pluginId) {
          saved.push([key, entry]);
          entries.delete(key);
        }
      }
      try {
        const result = fn();
        this.invalidatePlugin(pluginId);
        return result;
      } catch (error) {
        for (const [key, entry] of entries) {
          if (entry.pluginId === pluginId) {
            entries.delete(key);
          }
        }
        for (const [key, entry] of saved) {
          entries.set(key, entry);
        }
        throw error;
      }
    },

    invalidatePlugin(pluginId: string): void {
      const prefix = `${pluginId}/`;
      for (const key of statusCache.keys()) {
        if (key.startsWith(prefix)) {
          statusCache.delete(key);
        }
      }
      for (const key of latestGenerations.keys()) {
        if (key.startsWith(prefix)) {
          latestGenerations.delete(key);
        }
      }
    },

    warmStatus,
    refreshPluginStatus,

    async listSummaries(
      hostProfile,
    ): Promise<readonly ProviderSourceSummary[]> {
      const permissionService = deps.getPermissionService();
      if (
        !permissionService ||
        hostProfile?.capabilities["plugin.providerSource"] === "disabled" ||
        permissionService.snapshot(hostProfile).capabilities[
          "plugin.providerSource"
        ] === "disabled"
      ) {
        return [];
      }

      const items: ProviderSourceSummary[] = [];
      const sortedPlugins = [...registry.getAll().values()].sort((a, b) =>
        compareText(a.id, b.id),
      );
      for (const entry of sortedPlugins) {
        const decls =
          entry.packageManifest?.plugin.contributes?.providerSources ?? [];
        for (const decl of decls) {
          const qualifiedId = qualifiedProviderSourceId(entry.id, decl.id);
          const declared = lookupDeclared(qualifiedId);
          if (!declared) continue;
          const status = await inspectDeclaredStatus(declared, {
            allowActivation: true,
            hostProfile,
          });
          items.push({
            id: qualifiedId,
            pluginId: entry.id,
            sourceId: decl.id,
            label: decl.label,
            protocol: decl.protocol ?? DEFAULT_PROVIDER_PROTOCOL,
            modes: decl.modes ?? ["text"],
            baseUrl: decl.baseUrl,
            accountsMode: decl.accounts ?? "one",
            authFlows: decl.auth?.flows ?? [],
            ready: status.ready,
            ...(status.reason ? { reason: status.reason } : {}),
            accounts: status.accounts,
          });
        }
      }
      return items;
    },

    listModels(args): Promise<readonly string[]> {
      return runProviderSourceAdminCall(
        args,
        async ({ declared, registered, signal }) => {
          if (!registered.source.listModels) {
            throw new ProviderSourceHostError(
              404,
              "provider_source_models_unsupported",
              `Provider source "${args.sourceId}" does not support listing models`,
            );
          }
          return registered.source.listModels(
            { ...(args.accountId ? { accountId: args.accountId } : {}) },
            buildContext(declared, signal),
          );
        },
      );
    },

    getUsage(args): Promise<ProviderSourceUsageSummary | null> {
      return runProviderSourceAdminCall(
        args,
        async ({ declared, registered, signal }) => {
          if (!registered.source.getUsage) {
            return null;
          }
          return registered.source.getUsage(
            { ...(args.accountId ? { accountId: args.accountId } : {}) },
            buildContext(declared, signal),
          );
        },
      );
    },

    resolver,
  };
}
