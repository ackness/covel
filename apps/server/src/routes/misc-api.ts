/**
 * Miscellaneous API routes — presets, packages, commands, llm-config, provider-keys.
 *
 * These endpoints are consumed by the frontend boot sequence.
 */

import { Hono } from "hono";
import { z } from "zod";
import {
  getBuiltinProviderConnection,
  providerApiKeysFromEnv,
} from "@covel/shared";
import {
  parseQualifiedProviderSourceId,
  qualifiedProviderSourceId,
} from "@covel/shared/platform";
import { reloadAiStack, type AiStack } from "../ai-setup.js";
import {
  applySlotOverlay,
  classifyProviderFailure,
  listProtocolModels,
  listProviderProtocols,
  providerProtocolSchema,
  publicPresetId,
  resolveModelBinding,
} from "@covel/ai-provider";
import type { PluginRegistry } from "@covel/plugin-loader";
import type { DataStore } from "@covel/store";
import type { PermissionService } from "../trust/permission-service.js";
import type { TrustedSourceService } from "../trust/trusted-source-service.js";
import {
  ProviderSourceHostError,
  type ProviderSourceHost,
} from "./api/bootstrap/provider-sources.js";
import { buildPluginFlowResponse } from "./misc-api/plugin-flow.js";
import { envOverriddenProviders } from "../lib/env-key-overrides.js";
import { buildUiSpecsResponse } from "./misc-api/ui-specs.js";
import { checkSessionOwner } from "./api/session/session-guard.js";
import {
  accessGuard,
  allowsAccess,
  desktopHome,
  hostProfileOf,
  requireAccess,
} from "../host-profile.js";
import { readJsonBody, errorBody } from "../api-error.js";
import { modelParameters } from "./misc-api/model-parameters.js";
import { hasServerRuntimeJobCredentials } from "../runtime-job-readiness.js";
import { getRequestLlmOptions } from "../request-llm-context.js";
import {
  parseProviderKeys,
  parseSlotOverrides,
} from "../middleware/per-request-llm.js";

const MODEL_LIST_TIMEOUT_MS = 15_000;
const MODEL_LIST_LIMIT = 2000;

export function createMiscApiRoutes(
  ai: AiStack,
  registry: PluginRegistry,
  store: DataStore,
  apiKeys: Readonly<Record<string, string>> = providerApiKeysFromEnv(),
  options?: {
    readonly permissionService?: PermissionService;
    readonly trustedSources?: TrustedSourceService;
    readonly providerSources?: ProviderSourceHost;
  },
): Hono {
  const app = new Hono();
  const visibleBaseUrl = (
    canReadDiagnostics: boolean,
    provider: string,
    baseUrl: string | undefined,
  ) => {
    if (canReadDiagnostics) return baseUrl;
    if (ai.configSource?.kind !== "builtin" || !baseUrl) return undefined;
    const connection = getBuiltinProviderConnection(provider);
    return connection && !connection.local && connection.baseUrl === baseUrl
      ? baseUrl
      : undefined;
  };
  const inspectSourceForRequest = (
    c: Parameters<typeof hostProfileOf>[0],
    source: string | undefined,
    account: string | undefined,
  ) => {
    if (!source) return undefined;
    if (hostProfileOf(c).capabilities["plugin.providerSource"] === "disabled") {
      return {
        sourceId: source,
        ...(account ? { accountId: account } : {}),
        ready: false,
        reason: "capability_denied",
      };
    }
    return (
      ai.getProviderSourceResolver?.()?.inspectSync(source, account) ?? {
        sourceId: source,
        ...(account ? { accountId: account } : {}),
        ready: false,
        reason: "uninitialized",
      }
    );
  };
  const projectCredentialSource = (
    inspected: ReturnType<typeof inspectSourceForRequest>,
  ) =>
    inspected
      ? {
          sourceId: inspected.sourceId,
          ...(inspected.accountId ? { accountId: inspected.accountId } : {}),
          ready: inspected.ready,
          ...(inspected.reason ? { reason: inspected.reason } : {}),
        }
      : undefined;

  const diagnosticSourceFields = (
    canReadDiagnostics: boolean,
    source: string | undefined,
    account: string | undefined,
    credentialSource: ReturnType<typeof projectCredentialSource>,
  ) =>
    canReadDiagnostics
      ? {
          ...(source ? { source } : {}),
          ...(account ? { account } : {}),
          ...(credentialSource ? { credentialSource } : {}),
        }
      : {};

  // GET /api/presets — list configured model presets
  //
  // Each entry carries enough info for the settings UI to identify exactly
  // what a Ping would hit:
  //   - `baseUrl`: public built-in endpoint or operator diagnostics
  //   - `protocol`: preset-level protocol, else the provider default
  //   - `slotBindings`: every slot id whose `presetId` resolves here — lets
  //     the UI show e.g. `default, fast` next to the preset so operators can
  //     tell which aliases share a single underlying model.
  app.get("/api/presets", (c) => {
    const canReadDiagnostics = allowsAccess(c, "server.diagnostics");
    const slotMap = ai.slotRegistry.listSlots();
    const slotBindingsByPreset = new Map<string, string[]>();
    for (const [slotId, slot] of Object.entries(slotMap)) {
      const list = slotBindingsByPreset.get(slot.presetId) ?? [];
      list.push(slotId);
      slotBindingsByPreset.set(slot.presetId, list);
    }

    const presets = ai.presetRegistry.listPresets().map((p) => {
      const inspected = inspectSourceForRequest(c, p.source, p.account);
      const credentialSource = projectCredentialSource(inspected);
      // Fall back to the provider's registered default baseUrl/protocol
      // when the preset itself doesn't override them.
      let providerBaseUrl: string | undefined = inspected?.baseUrl;
      let providerProtocol: string | undefined = inspected?.protocol;
      try {
        const resolution = ai.providerRegistry.resolve({
          provider: p.provider,
          ...(p.source ? { source: p.source } : {}),
        });
        providerBaseUrl = resolution.config.baseUrl ?? providerBaseUrl;
        providerProtocol = resolution.protocol ?? providerProtocol;
      } catch {
        // Unknown provider — keep source-derived values or leave undefined.
      }

      return {
        id: p.id,
        name: p.name,
        provider: p.provider,
        ...diagnosticSourceFields(
          canReadDiagnostics,
          p.source,
          p.account,
          credentialSource,
        ),
        model: p.model,
        enabled: p.enabled,
        isDefault: p.isDefault ?? false,
        scope: "global",
        baseUrl: visibleBaseUrl(
          canReadDiagnostics,
          p.provider,
          p.baseUrl ?? providerBaseUrl,
        ),
        protocol: p.protocol ?? providerProtocol,
        slotBindings: slotBindingsByPreset.get(p.id) ?? [],
        ...(p.capability ? { capability: p.capability } : {}),
        parameterOverrides: modelParameters(p.providerRequestMetadata),
      };
    });
    return c.json({ items: presets });
  });

  // GET /api/plugin-flows — framework-orchestrated flow data for pre-game preview
  app.get("/api/plugin-flows", (c) => {
    const payload = buildPluginFlowResponse(registry);
    return c.json(payload);
  });

  // GET /api/ui-specs — list UI specs from plugin manifests, grouped by slot.
  // When ?sessionId= is provided, filter to that session's activePlugins so the
  // panel only shows plugins actually enabled for the current session.
  // (Audit Finding w2 — without this, RightPanel shows specs for plugins that
  // are loaded globally but not enabled for the active session.)
  app.get("/api/ui-specs", async (c) => {
    const sessionId = c.req.query("sessionId");
    // Owner guard: a session-scoped request reads the session's active plugin
    // set. The response itself is a pure projection of the registry snapshot;
    // it never materialises static UI definitions into plugin_data.
    // misc-api routes mount on the root app (no bootstrap middleware), so
    // the closure `store` is passed explicitly.
    if (sessionId) {
      const initialSession = await store.getSession(sessionId);
      if (!initialSession) {
        return c.json(
          errorBody(`Session not found: ${sessionId}`, {
            code: "session_not_found",
          }),
          404,
        );
      }
      const denied = checkSessionOwner(c, initialSession);
      if (denied) return denied;
      return c.json(
        await buildUiSpecsResponse({
          sessionId,
          session: initialSession,
          registry,
          store,
          permissionService: options?.permissionService,
          trustedSources: options?.trustedSources,
        }),
      );
    }
    return c.json(
      await buildUiSpecsResponse({
        sessionId,
        registry,
        store,
        permissionService: options?.permissionService,
        trustedSources: options?.trustedSources,
      }),
    );
  });

  // GET /api/llm-config — return slot configuration with capability info
  app.get("/api/llm-config", (c) => {
    const canReadDiagnostics = allowsAccess(c, "server.diagnostics");
    const slots = ai.slotRegistry.listSlots();
    const slotsInfo: Record<string, Record<string, unknown>> = {};

    for (const [slotId, slot] of Object.entries(slots)) {
      const preset = ai.presetRegistry
        .listPresets()
        .find((p) => p.id === slot.presetId);
      if (!preset) continue;
      const inspected = inspectSourceForRequest(
        c,
        preset.source,
        preset.account,
      );
      const credentialSource = projectCredentialSource(inspected);
      const resolved = ai.providerRegistry.resolve(preset);
      const fallbackPresetId = preset.fallbackPresetIds?.[0];
      const fallbackSlotId =
        typeof fallbackPresetId === "string"
          ? fallbackPresetId.startsWith("slot-")
            ? fallbackPresetId.slice("slot-".length)
            : fallbackPresetId
          : undefined;
      slotsInfo[slotId] = {
        baseUrl: visibleBaseUrl(
          canReadDiagnostics,
          preset.provider,
          resolved.config.baseUrl ?? inspected?.baseUrl,
        ),
        provider: preset.provider,
        ...diagnosticSourceFields(
          canReadDiagnostics,
          preset.source,
          preset.account,
          credentialSource,
        ),
        model: preset.model,
        protocol:
          resolved.protocol ?? inspected?.protocol ?? "openai-responses-v1",
        builtinDefault: ai.configSource?.kind === "builtin",
        serverKeyConfigured: preset.source
          ? Boolean(
              hostProfileOf(c).capabilities["plugin.providerSource"] !==
                "disabled" && inspected?.ready,
            )
          : hasServerRuntimeJobCredentials(ai.gateway, slotId, apiKeys),
        tag: slot.tag,
        ...(fallbackSlotId ? { fallback: fallbackSlotId } : {}),
        ...(preset.capability ? { capability: preset.capability } : {}),
        parameterOverrides: modelParameters(
          preset.providerRequestMetadata,
          ai.slotRegistry.getParameterOverrides(slotId),
        ),
      };
    }

    return c.json({
      configured: Object.keys(slotsInfo).length > 0,
      slots: slotsInfo,
      providers: [
        ...new Set(ai.presetRegistry.listPresets().map((p) => p.provider)),
      ],
      ...(canReadDiagnostics ? { source: ai.configSource } : {}),
      // Providers whose saved key (Settings) is shadowed by the environment.
      ...(canReadDiagnostics
        ? { envKeyOverrides: envOverriddenProviders(desktopHome()) }
        : {}),
      // Reload failures preserve the last valid active configuration.
      ...(canReadDiagnostics && ai.lastLoadError
        ? { error: ai.lastLoadError }
        : {}),
    });
  });

  // POST /api/llm-config/reload — re-read llm.toml and apply it to the live
  // gateway in place (no restart). Same rule as the desktop config writes
  // (`host.config`): the desktop token when one is configured, open on a
  // personal host without one. Always returns 200 on a completed reload. A
  // parse failure keeps the active configuration.
  app.post("/api/llm-config/reload", accessGuard("host.config"), (c) =>
    c.json(reloadAiStack(ai)),
  );

  // GET /api/provider-keys — live availability only; secrets stay at their owner.
  app.get("/api/provider-keys", (c) => {
    const denied = requireAccess(c, "server.diagnostics");
    if (denied) return denied;
    const providers: Record<string, { configured: boolean }> = {};
    for (const [provider, value] of Object.entries(apiKeys)) {
      if (value.trim()) providers[provider] = { configured: true };
    }
    return c.json({ providers });
  });

  // GET /api/ai/protocols — every protocol a model can be configured with:
  // the built-in ones and the text protocols that loaded plugins register.
  app.get("/api/ai/protocols", (c) =>
    c.json({ protocols: listProviderProtocols() }),
  );

  // POST /api/ai/models — the model IDs a provider endpoint lists.
  //
  // The settings UI offers them when a player adds a provider or models, so a
  // local gateway with dozens of models needs no typed IDs. The target is
  // request-scoped: a server key attaches only to the provider's own trusted
  // origin, as it does for a model call.
  app.post("/api/ai/models", async (c) => {
    const denied = requireAccess(c, "model.probe");
    if (denied) return denied;
    const json = await readJsonBody(c);
    if (json instanceof Response) return json;
    const parsedBody = z
      .strictObject({
        provider: z.string().trim().min(1).max(100).optional(),
        source: z.string().trim().min(1).max(128).optional(),
        account: z.string().trim().min(1).max(128).optional(),
        baseUrl: z.string().trim().url().max(500).optional(),
        protocol: providerProtocolSchema.optional(),
      })
      .refine((data) => Boolean(data.provider || data.source), {
        message: "provider or source is required",
      })
      .safeParse(json.body);
    if (!parsedBody.success) {
      return c.json(errorBody("Invalid model list request body"), 400);
    }
    const { provider, source, account, baseUrl, protocol } = parsedBody.data;
    if (source) {
      if (!parseQualifiedProviderSourceId(source)) {
        return c.json(
          {
            ok: false,
            models: [],
            ...errorBody(`Invalid provider source "${source}"`, {
              code: "invalid_provider_source",
            }),
          },
          400,
        );
      }
      if (
        hostProfileOf(c).capabilities["plugin.providerSource"] === "disabled"
      ) {
        return c.json(
          {
            ok: false,
            models: [],
            ...errorBody("Provider sources are disabled in this host profile", {
              code: "capability_denied",
            }),
          },
          403,
        );
      }
      if (!options?.providerSources) {
        return c.json(
          {
            ok: false,
            models: [],
            ...errorBody("Provider source host is unavailable", {
              code: "provider_source_unavailable",
            }),
          },
          503,
        );
      }
      try {
        const models = await options.providerSources.listModels({
          sourceId: source,
          ...(account ? { accountId: account } : {}),
          signal: c.req.raw.signal,
          hostProfile: hostProfileOf(c),
        });
        return c.json({
          ok: true,
          models: models.slice(0, MODEL_LIST_LIMIT),
        });
      } catch (error) {
        if (error instanceof ProviderSourceHostError) {
          return c.json(
            {
              ok: false,
              models: [],
              ...errorBody(error.message, { code: error.code }),
            },
            error.status,
          );
        }
        const failure = classifyProviderFailure(error, source);
        return c.json({
          ok: false,
          models: [],
          error: failure.message,
          errorKind: failure.kind,
        });
      }
    }
    const targetProvider = provider!;
    try {
      const resolution = ai.providerRegistry.withApiKeys(
        ai.providerRegistry.resolve({
          provider: targetProvider,
          ...(baseUrl ? { baseUrl } : {}),
          ...(protocol ? { protocol } : {}),
          requestScoped: true,
        }),
        parseProviderKeys(c.req.header("X-Provider-Keys")) ?? {},
        targetProvider,
        apiKeys,
      );
      // The browser relays a model list from the player's own machine.
      const relay = getRequestLlmOptions()?.relay;
      const models = await listProtocolModels(
        resolution.protocol,
        relay ? { ...resolution.config, relay } : resolution.config,
        targetProvider,
        AbortSignal.timeout(MODEL_LIST_TIMEOUT_MS),
      );
      return c.json({
        ok: true,
        models: models.slice(0, MODEL_LIST_LIMIT),
        baseUrl: resolution.config.baseUrl,
        protocol: resolution.protocol,
      });
    } catch (error) {
      console.warn(
        `[misc-api] POST /api/ai/models failed for provider "${targetProvider}":`,
        error,
      );
      const failure = classifyProviderFailure(error, targetProvider);
      return c.json({
        ok: false,
        models: [],
        error: failure.message,
        errorKind: failure.kind,
      });
    }
  });

  // POST /api/ai/ping — real provider latency probe.
  //
  // Streams a minimal "hi" completion and records time-to-first-token
  // (TTFB) against the first non-empty `text-delta` or `reasoning-delta`
  // event (so "thinking" models are measured on their first reasoning
  // character, not the first visible text token).
  //
  // The stream is aborted shortly after the first content arrives to keep
  // the probe cheap — we only care about connectivity + latency, not the
  // full reply.
  app.post("/api/ai/ping", async (c) => {
    const denied = requireAccess(c, "model.probe");
    if (denied) return denied;
    const json = await readJsonBody(c);
    if (json instanceof Response) return json;
    const parsedBody = z
      .strictObject({
        presetId: z
          .string()
          .min(1)
          .refine((id) => !id.includes("\u0000"))
          .optional(),
        modelRef: z.string().trim().min(1).optional(),
        slot: z.string().min(1).optional(),
      })
      .refine(
        (body) =>
          [body.presetId, body.modelRef, body.slot].filter(
            (value) => value !== undefined,
          ).length <= 1,
      )
      .safeParse(json.body);
    if (!parsedBody.success) {
      return c.json(errorBody("Invalid ping request body"), 400);
    }
    const body = parsedBody.data;
    const requestApiKeys =
      parseProviderKeys(c.req.header("X-Provider-Keys")) ?? {};
    const slotHeader = c.req.header("X-Slot-Config");
    const parsedSlots = parseSlotOverrides(slotHeader);
    if (slotHeader !== undefined && parsedSlots === null) {
      return c.json(
        errorBody("Invalid model configuration", {
          code: "invalid_llm_configuration",
        }),
        400,
      );
    }
    const slotConfig = parsedSlots ?? {};
    const requestedSlot =
      body.presetId || body.modelRef ? undefined : (body.slot ?? "default");

    // Register client-declared custom presets via the shared overlay helper
    // (request-isolated scoped ids, ref-counted, base-registry-safe).
    const cleanupTransient = applySlotOverlay(ai, slotConfig);

    const serverPresets = ai.presetRegistry
      .listPresets()
      .filter((p) => p.enabled);
    const findBinding = (binding: import("@covel/shared").LlmModelBinding) => {
      const id = resolveModelBinding(binding, slotConfig, (key) =>
        ai.presetRegistry.hasPreset(key),
      );
      return ai.presetRegistry.resolvePreset(id) ?? undefined;
    };
    type ResolvedVia = "direct" | "slot" | "tag-fallback" | "any";
    let resolvedVia: ResolvedVia = "direct";
    let preset: (typeof serverPresets)[number] | undefined;
    const explicitBinding = body.modelRef
      ? { modelRef: body.modelRef }
      : body.presetId
        ? { presetId: body.presetId }
        : requestedSlot
          ? slotConfig.slotBindings?.[requestedSlot]
          : undefined;
    try {
      if (explicitBinding) {
        preset = findBinding(explicitBinding);
        if (requestedSlot) resolvedVia = "slot";
      } else if (requestedSlot) {
        const id = ai.slotRegistry.resolveSlot(requestedSlot);
        preset = serverPresets.find((p) => p.id === id);
        if (preset) resolvedVia = "slot";
      }
      if (!preset && !explicitBinding) {
        const textSlots = ai.slotRegistry.listSlotsByTag("text");
        preset = serverPresets.find((p) => p.id === textSlots[0]?.presetId);
        if (preset) resolvedVia = "tag-fallback";
      }
      if (!preset && !explicitBinding) {
        preset = serverPresets[0];
        if (preset) resolvedVia = "any";
      }
    } catch {
      // A missing explicit reference must never probe a different model.
    }
    if (!preset) {
      cleanupTransient();
      return c.json({
        ok: false,
        latencyMs: 0,
        error: explicitBinding
          ? "Selected model is not available."
          : "No LLM provider configured. Add a slot to llm.toml or via Settings.",
      });
    }

    // Resolve the effective baseUrl/protocol once so error + success paths
    // both report the exact target. Unknown providers can still ping via
    // the preset's own baseUrl, so treat resolution failure as non-fatal.
    const inspectedSource = inspectSourceForRequest(
      c,
      preset.source,
      preset.account,
    );
    let effectiveBaseUrl = preset.baseUrl ?? inspectedSource?.baseUrl;
    let effectiveProtocol: string | undefined =
      preset.protocol ?? inspectedSource?.protocol;
    try {
      const resolution = ai.providerRegistry.resolve({
        provider: preset.provider,
        ...(preset.source ? { source: preset.source } : {}),
        baseUrl: preset.baseUrl,
        protocol: preset.protocol,
      });
      effectiveBaseUrl = resolution.config.baseUrl ?? effectiveBaseUrl;
      effectiveProtocol = resolution.protocol ?? effectiveProtocol;
    } catch {
      // Provider not registered — fall back to preset/source fields as-is.
    }

    const testedTarget = {
      // Overlay presets carry internal scoped ids — echo the public form.
      presetId: publicPresetId(preset.id),
      provider: preset.provider,
      ...(preset.source ? { source: preset.source } : {}),
      ...(preset.account ? { account: preset.account } : {}),
      model: preset.model,
      baseUrl: effectiveBaseUrl,
      protocol: effectiveProtocol,
      resolvedVia,
    };

    const startedAt = Date.now();
    let ttfbMs: number | null = null;
    let firstText = "";
    let finalUsage: { inputTokens: number; outputTokens: number } | null = null;
    const abort = new AbortController();
    let aborted = false;
    let timedOut = false;

    // Safety timeout — a ping that can't even start streaming within 30s is
    // effectively broken. Without this the endpoint would hang indefinitely
    // on misconfigured providers (wrong baseUrl, unreachable host, ...).
    const timeout = setTimeout(() => {
      if (!aborted) {
        timedOut = true;
        aborted = true;
        abort.abort();
      }
    }, 30_000);

    const relay = getRequestLlmOptions()?.relay;
    const gatewayOptions: import("@covel/ai-provider").GatewayOptions = {
      apiKeys: requestApiKeys,
      signal: abort.signal,
      ...(relay ? { relay } : {}),
      allowFallback: false,
      // One request: a retried probe would report a later answer and the
      // time of the waits as the model's own.
      transportRetry: false,
      envApiKeys: apiKeys,
      slotOverrides: requestedSlot
        ? {
            ...slotConfig,
            // Pin the resolved target while retaining the original slot's
            // parameter/capability keys and its local/server namespace.
            slotBindings: {
              [requestedSlot]: explicitBinding ?? { presetId: preset.id },
            },
          }
        : { ...slotConfig, slotBindings: undefined },
      capabilityOverridePolicy:
        hostProfileOf(c).credentials.capabilityOverrides,
    };
    try {
      if (preset.supportedModes.includes("evaluate")) {
        const result = await ai.gateway.evaluate(
          {
            presetId: requestedSlot ?? preset.id,
            state: "Connection test",
            questions: {
              connected: {
                type: "boolean",
                instructions: "Is this a connection test?",
              },
            },
          },
          gatewayOptions,
        );
        return c.json({
          ok: true,
          latencyMs: Date.now() - startedAt,
          usage: result.usage,
          testedTarget,
        });
      }
      // An embedding model has no text stream: it answers one vector call.
      if (
        preset.supportedModes.includes("embed") &&
        !preset.supportedModes.includes("stream")
      ) {
        const result = await ai.gateway.embed(
          { presetId: requestedSlot ?? preset.id, values: ["hi"] },
          gatewayOptions,
        );
        return c.json({
          ok: true,
          latencyMs: Date.now() - startedAt,
          usage: result.usage,
          testedTarget,
        });
      }
      for await (const event of ai.gateway.streamText(
        {
          presetId: requestedSlot ?? preset.id,
          messages: [{ role: "user", content: "hi" }],
        },
        gatewayOptions,
      )) {
        if (event.type === "text-delta" && event.textDelta.length > 0) {
          if (ttfbMs === null) ttfbMs = Date.now() - startedAt;
          firstText += event.textDelta;
          // Stop once we have proof-of-life; keeps probe cheap (~1 token).
          if (firstText.length >= 8 && !aborted) {
            aborted = true;
            abort.abort();
          }
        } else if (
          event.type === "reasoning-delta" &&
          event.reasoningDelta.length > 0
        ) {
          if (ttfbMs === null) ttfbMs = Date.now() - startedAt;
        } else if (event.type === "done") {
          finalUsage = event.usage;
        }
      }
    } catch (err) {
      if (!aborted) {
        const failure = classifyProviderFailure(err, preset.provider);
        return c.json({
          ok: false,
          latencyMs: Date.now() - startedAt,
          ...(ttfbMs !== null ? { ttfbMs } : {}),
          error: failure.message,
          errorKind: failure.kind,
          testedTarget,
        });
      }
      // Deliberate abort — either a post-TTFB early-stop or our 30s timeout.
    } finally {
      clearTimeout(timeout);
      cleanupTransient();
    }
    const latencyMs = Date.now() - startedAt;
    if (ttfbMs === null) {
      return c.json({
        ok: false,
        latencyMs,
        error: timedOut
          ? "Provider did not return any content within 30s"
          : "Provider returned no content",
        errorKind: timedOut ? "timeout" : "unknown",
        testedTarget,
      });
    }

    return c.json({
      ok: true,
      latencyMs,
      ttfbMs,
      text: `${preset.name} (${preset.provider}/${preset.model})`,
      ...(finalUsage ? { usage: finalUsage } : {}),
      testedTarget,
    });
  });

  app.get("/api/provider-sources", accessGuard("host.config"), async (c) => {
    if (!options?.providerSources) {
      return c.json({ sources: [] });
    }
    const sources = await options.providerSources.listSummaries(
      hostProfileOf(c),
    );
    return c.json({ sources });
  });

  app.get(
    "/api/provider-sources/:pluginId/:sourceId/usage",
    accessGuard("host.config"),
    async (c) => {
      const pluginId = c.req.param("pluginId");
      const sourceId = c.req.param("sourceId");
      const qualified = qualifiedProviderSourceId(pluginId, sourceId);
      if (!parseQualifiedProviderSourceId(qualified)) {
        return c.json(
          errorBody(`Invalid provider source "${qualified}"`, {
            code: "invalid_provider_source",
          }),
          400,
        );
      }
      if (
        hostProfileOf(c).capabilities["plugin.providerSource"] === "disabled"
      ) {
        return c.json(
          errorBody("Provider sources are disabled in this host profile", {
            code: "capability_denied",
          }),
          403,
        );
      }
      if (!options?.providerSources) {
        return c.json(
          errorBody("Provider source host is unavailable", {
            code: "provider_source_unavailable",
          }),
          503,
        );
      }
      const account = c.req.query("account")?.trim() || undefined;
      try {
        const usage = await options.providerSources.getUsage({
          sourceId: qualified,
          ...(account ? { accountId: account } : {}),
          signal: c.req.raw.signal,
          hostProfile: hostProfileOf(c),
        });
        return c.json({ usage });
      } catch (error) {
        if (error instanceof ProviderSourceHostError) {
          return c.json(
            errorBody(error.message, { code: error.code }),
            error.status,
          );
        }
        throw error;
      }
    },
  );

  return app;
}
