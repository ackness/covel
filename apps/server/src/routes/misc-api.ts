/**
 * Miscellaneous API routes — presets, packages, commands, llm-config, provider-keys.
 *
 * These endpoints are consumed by the frontend boot sequence.
 */

import { Hono } from "hono";
import { z } from "zod";
import { providerApiKeysFromEnv, readRuntimeEnv } from "@covel/shared";
import { reloadAiStack, type AiStack } from "../ai-setup.js";
import {
  PROVIDER_PROTOCOLS,
  applySlotOverlay,
  classifyProviderFailure,
  listProtocolModels,
  publicPresetId,
  resolveModelBinding,
} from "@covel/ai-provider";
import type { PluginRegistry } from "@covel/plugin-loader";
import type { DataStore } from "@covel/store";
import { buildPluginFlowResponse } from "./misc-api/plugin-flow.js";
import { bearerToken } from "./misc-api/shared.js";
import { buildUiSpecsResponse } from "./misc-api/ui-specs.js";
import {
  checkHostedOperator,
  checkSessionOwner,
  safeEqual,
} from "./api/session/session-guard.js";
import { errorBody } from "../api-error.js";
import { modelParameters } from "./misc-api/model-parameters.js";
import { hasServerRuntimeJobCredentials } from "../runtime-job-readiness.js";
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
): Hono {
  const app = new Hono();

  // GET /api/presets — list configured model presets
  //
  // Each entry carries enough info for the settings UI to identify exactly
  // what a Ping would hit:
  //   - `baseUrl`: preset-level override, else the provider default
  //   - `protocol`: preset-level protocol, else the provider default
  //   - `slotBindings`: every slot id whose `presetId` resolves here — lets
  //     the UI show e.g. `default, fast` next to the preset so operators can
  //     tell which aliases share a single underlying model.
  app.get("/api/presets", (c) => {
    const slotMap = ai.slotRegistry.listSlots();
    const slotBindingsByPreset = new Map<string, string[]>();
    for (const [slotId, slot] of Object.entries(slotMap)) {
      const list = slotBindingsByPreset.get(slot.presetId) ?? [];
      list.push(slotId);
      slotBindingsByPreset.set(slot.presetId, list);
    }

    const presets = ai.presetRegistry.listPresets().map((p) => {
      // Fall back to the provider's registered default baseUrl/protocol
      // when the preset itself doesn't override them. `resolve` never
      // throws for a known provider; unknown providers return null here.
      let providerBaseUrl: string | undefined;
      let providerProtocol: string | undefined;
      try {
        const resolution = ai.providerRegistry.resolve({
          provider: p.provider,
        });
        providerBaseUrl = resolution.config.baseUrl;
        providerProtocol = resolution.protocol;
      } catch {
        // Unknown provider — leave both undefined; the UI will show "-"
      }

      return {
        id: p.id,
        name: p.name,
        provider: p.provider,
        model: p.model,
        enabled: p.enabled,
        isDefault: p.isDefault ?? false,
        scope: "global",
        baseUrl: p.baseUrl ?? providerBaseUrl,
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
        }),
      );
    }
    return c.json(
      await buildUiSpecsResponse({
        sessionId,
        registry,
        store,
      }),
    );
  });

  // GET /api/llm-config — return slot configuration with capability info
  app.get("/api/llm-config", (c) => {
    const canReadDiagnostics = !checkHostedOperator(c);
    const slots = ai.slotRegistry.listSlots();
    const slotsInfo: Record<string, Record<string, unknown>> = {};

    for (const [slotId, slot] of Object.entries(slots)) {
      const preset = ai.presetRegistry
        .listPresets()
        .find((p) => p.id === slot.presetId);
      if (!preset) continue;
      const resolved = ai.providerRegistry.resolve(preset);
      const fallbackPresetId = preset.fallbackPresetIds?.[0];
      const fallbackSlotId =
        typeof fallbackPresetId === "string"
          ? fallbackPresetId.startsWith("slot-")
            ? fallbackPresetId.slice("slot-".length)
            : fallbackPresetId
          : undefined;
      slotsInfo[slotId] = {
        baseUrl: resolved.config.baseUrl,
        provider: preset.provider,
        model: preset.model,
        protocol: resolved.protocol,
        serverKeyConfigured: hasServerRuntimeJobCredentials(
          ai.gateway,
          slotId,
          apiKeys,
        ),
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
      // Reload failures preserve the last valid active configuration.
      ...(canReadDiagnostics && ai.lastLoadError
        ? { error: ai.lastLoadError }
        : {}),
    });
  });

  // POST /api/llm-config/reload — re-read llm.toml and apply it to the live
  // gateway in place (no restart). Mirrors the desktop write-endpoint auth:
  // when a desktop REST token is configured the request must carry it; dev/web
  // tiers (no token) stay open, matching the rest of misc-api. Always returns
  // 200 on a completed reload. A parse failure keeps the active configuration.
  app.post("/api/llm-config/reload", (c) => {
    const env = readRuntimeEnv();
    const provided = bearerToken(c);
    if (
      env.desktopRestToken &&
      (!provided || !safeEqual(provided, env.desktopRestToken))
    ) {
      return c.json(errorBody("Unauthorized", { code: "unauthorized" }), 401);
    }
    return c.json(reloadAiStack(ai));
  });

  // GET /api/provider-keys — live availability only; secrets stay at their owner.
  app.get("/api/provider-keys", (c) => {
    const denied = checkHostedOperator(c);
    if (denied) return denied;
    const providers: Record<string, { configured: boolean }> = {};
    for (const [provider, value] of Object.entries(apiKeys)) {
      if (value.trim()) providers[provider] = { configured: true };
    }
    return c.json({ providers });
  });

  // POST /api/ai/models — the model IDs a provider endpoint lists.
  //
  // The settings UI offers them when a player adds a provider or models, so a
  // local gateway with dozens of models needs no typed IDs. The target is
  // request-scoped: a server key attaches only to the provider's own trusted
  // origin, as it does for a model call.
  app.post("/api/ai/models", async (c) => {
    const denied = checkHostedOperator(c);
    if (denied) return denied;
    const parsedBody = z
      .strictObject({
        provider: z.string().trim().min(1).max(100),
        baseUrl: z.string().trim().url().max(500).optional(),
        protocol: z.enum(PROVIDER_PROTOCOLS).optional(),
      })
      .safeParse(await c.req.json().catch(() => undefined));
    if (!parsedBody.success) {
      return c.json(errorBody("Invalid model list request body"), 400);
    }
    const { provider, baseUrl, protocol } = parsedBody.data;
    try {
      const resolution = ai.providerRegistry.withApiKeys(
        ai.providerRegistry.resolve({
          provider,
          ...(baseUrl ? { baseUrl } : {}),
          ...(protocol ? { protocol } : {}),
          requestScoped: true,
        }),
        parseProviderKeys(c.req.header("X-Provider-Keys")) ?? {},
        provider,
        providerApiKeysFromEnv(),
      );
      const models = await listProtocolModels(
        resolution.protocol,
        resolution.config,
        provider,
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
        `[misc-api] POST /api/ai/models failed for provider "${provider}":`,
        error,
      );
      const failure = classifyProviderFailure(error, provider);
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
    const denied = checkHostedOperator(c);
    if (denied) return denied;
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
      .safeParse(await c.req.json().catch(() => undefined));
    if (!parsedBody.success) {
      return c.json(errorBody("Invalid ping request body"), 400);
    }
    const body = parsedBody.data;
    const apiKeys = parseProviderKeys(c.req.header("X-Provider-Keys")) ?? {};
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
    let effectiveBaseUrl = preset.baseUrl;
    let effectiveProtocol: string | undefined = preset.protocol;
    try {
      const resolution = ai.providerRegistry.resolve({
        provider: preset.provider,
        baseUrl: preset.baseUrl,
        protocol: preset.protocol,
      });
      effectiveBaseUrl = resolution.config.baseUrl ?? preset.baseUrl;
      effectiveProtocol = resolution.protocol;
    } catch {
      // Provider not registered — fall back to preset fields as-is.
    }

    const testedTarget = {
      // Overlay presets carry internal scoped ids — echo the public form.
      presetId: publicPresetId(preset.id),
      provider: preset.provider,
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

    const gatewayOptions: import("@covel/ai-provider").GatewayOptions = {
      apiKeys,
      signal: abort.signal,
      allowFallback: false,
      // One request: a retried probe would report a later answer and the
      // time of the waits as the model's own.
      transportRetry: false,
      envApiKeys: providerApiKeysFromEnv(),
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
        readRuntimeEnv().deploymentTier === "self" ? "full" : "restrict-only",
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
        clearTimeout(timeout);
        cleanupTransient();
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
        clearTimeout(timeout);
        cleanupTransient();
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
        clearTimeout(timeout);
        cleanupTransient();
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
    }

    clearTimeout(timeout);
    cleanupTransient();
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

  return app;
}
