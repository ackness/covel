/**
 * Miscellaneous API routes — presets, packages, commands, block-schemas, llm-config, provider-keys.
 *
 * These endpoints are consumed by the frontend boot sequence.
 */

import { Hono } from "hono";
import { readEnvString, readRuntimeEnv } from "@covel/shared";
import { reloadAiStack, type AiStack } from "../ai-setup.js";
import { applySlotOverlay, type SlotOverridesInput } from "@covel/ai-provider";
import type { PluginRegistry } from "@covel/plugin-loader";
import type { DataStore } from "@covel/store";
import { buildPackagesResponse } from "./misc-api/plugin-catalog.js";
import { buildPluginFlowResponse } from "./misc-api/plugin-flow.js";
import { bearerToken } from "./misc-api/shared.js";
import { buildUiSpecsResponse } from "./misc-api/ui-specs.js";

export function createMiscApiRoutes(
  ai: AiStack,
  registry: PluginRegistry,
  store: DataStore,
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
      };
    });
    return c.json(presets);
  });

  // GET /api/packages — list loaded plugin packages with runtime/tool info
  app.get("/api/packages", async (c) => {
    return c.json(await buildPackagesResponse(registry));
  });

  // GET /api/plugin-flows — framework-orchestrated flow data for pre-game preview
  app.get("/api/plugin-flows", async (c) => {
    const payload = await buildPluginFlowResponse();
    return c.json(payload);
  });

  // GET /api/commands — list registered commands
  // TODO: populate from plugin command registry when command system is implemented
  app.get("/api/commands", (c) => {
    return c.json([]);
  });

  // GET /api/block-schemas — list block schemas from plugin manifests
  app.get("/api/block-schemas", (c) => {
    const schemas: Record<string, unknown> = {};
    const all = registry.getAll();
    for (const [, entry] of all) {
      const manifests =
        entry.manifests ?? (entry.manifest ? [entry.manifest] : []);
      for (const m of manifests) {
        // blockSchemas may be declared in rawFrontmatter (from PLUGIN.md) or plugin.json
        const bs = (m.rawFrontmatter as Record<string, unknown>).blockSchemas;
        if (bs && typeof bs === "object") {
          for (const [key, val] of Object.entries(
            bs as Record<string, unknown>,
          )) {
            schemas[key] = val;
          }
        }
      }
    }
    return c.json({ schemas });
  });

  // GET /api/ui-specs — list UI specs from plugin manifests, grouped by slot.
  // When ?sessionId= is provided, filter to that session's activePlugins so the
  // panel only shows plugins actually enabled for the current session.
  // (Audit Finding w2 — without this, RightPanel shows specs for plugins that
  // are loaded globally but not enabled for the active session.)
  app.get("/api/ui-specs", async (c) => {
    return c.json(
      await buildUiSpecsResponse({
        sessionId: c.req.query("sessionId"),
        registry,
        store,
      }),
    );
  });

  // GET /api/llm-config — return slot configuration with capability info
  app.get("/api/llm-config", (c) => {
    const slots = ai.slotRegistry.listSlots();
    const slotsInfo: Record<string, Record<string, unknown>> = {};

    for (const [slotId, slot] of Object.entries(slots)) {
      const preset = ai.presetRegistry
        .listPresets()
        .find((p) => p.id === slot.presetId);
      if (!preset) continue;
      const fallbackPresetId = preset.fallbackPresetIds?.[0];
      const fallbackSlotId =
        typeof fallbackPresetId === "string"
          ? fallbackPresetId.startsWith("slot-")
            ? fallbackPresetId.slice("slot-".length)
            : fallbackPresetId
          : undefined;
      slotsInfo[slotId] = {
        provider: preset.provider,
        model: preset.model,
        protocol: preset.protocol ?? "openai-chat-v1",
        tag: slot.tag,
        ...(fallbackSlotId ? { fallback: fallbackSlotId } : {}),
        ...(preset.capability ? { capability: preset.capability } : {}),
      };
    }

    return c.json({
      configured: Object.keys(slotsInfo).length > 0,
      slots: slotsInfo,
      providers: [
        ...new Set(ai.presetRegistry.listPresets().map((p) => p.provider)),
      ],
      // Present only when the last llm.toml load failed to parse and fell back
      // to the built-in default — lets the UI explain why slots are missing.
      ...(ai.lastLoadError ? { error: ai.lastLoadError } : {}),
    });
  });

  // POST /api/llm-config/reload — re-read llm.toml and apply it to the live
  // gateway in place (no restart). Mirrors the desktop write-endpoint auth:
  // when a desktop REST token is configured the request must carry it; dev/web
  // tiers (no token) stay open, matching the rest of misc-api. Always returns
  // 200 on a completed reload — the body's `ok` / `error` conveys whether the
  // file parsed (a broken file falls back to the default, reported via `error`).
  app.post("/api/llm-config/reload", (c) => {
    const env = readRuntimeEnv();
    if (env.desktopRestToken && bearerToken(c) !== env.desktopRestToken) {
      return c.json({ error: "Unauthorized" }, 401);
    }
    return c.json(reloadAiStack(ai));
  });

  // GET /api/provider-keys — return server-configured API keys to desktop bearer clients only.
  app.get("/api/provider-keys", (c) => {
    const KNOWN_PROVIDERS = [
      "DEEPSEEK",
      "DASHSCOPE",
      "OPENAI",
      "ANTHROPIC",
      "OPENROUTER",
    ] as const;

    const env = readRuntimeEnv();
    const allowRawKeys =
      !!env.desktopRestToken && bearerToken(c) === env.desktopRestToken;

    if (allowRawKeys) {
      const keys: Record<string, string> = {};
      for (const provider of KNOWN_PROVIDERS) {
        const envKey = `${provider}_API_KEY`;
        const value = readEnvString(envKey);
        if (value) keys[provider.toLowerCase()] = value;
      }
      return c.json({ keys });
    }

    // Non-T1 or non-localhost: return availability + masked metadata only
    const providers: Record<string, { configured: boolean; masked: string }> =
      {};
    for (const provider of KNOWN_PROVIDERS) {
      const envKey = `${provider}_API_KEY`;
      const value = readEnvString(envKey);
      if (value) {
        const masked =
          value.length > 8
            ? `${value.slice(0, 4)}...${value.slice(-4)}`
            : "****";
        providers[provider.toLowerCase()] = { configured: true, masked };
      }
    }
    return c.json({ keys: {}, providers });
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
    const body = await c.req
      .json<{ presetId?: string; slot?: string }>()
      .catch((): { presetId?: string; slot?: string } => ({}));
    const requested =
      body.presetId ?? (body.slot ? `slot-${body.slot}` : "slot-default");

    // Decode per-request API keys (base64 JSON). Keys are never persisted server-side.
    let apiKeys: Record<string, string> | undefined;
    const keysHeader = c.req.header("X-Provider-Keys");
    if (keysHeader) {
      try {
        const decoded = Buffer.from(keysHeader, "base64").toString("utf8");
        const parsed = JSON.parse(decoded);
        if (parsed && typeof parsed === "object")
          apiKeys = parsed as Record<string, string>;
      } catch {
        // Fall through — let gateway raise a clearer error if the key is actually needed.
      }
    }

    // Decode the client slot config header (base64 JSON). Shared with the
    // turn pipeline's per-request middleware — the ping endpoint needs its
    // own decode because ping can be called before the per-request
    // middleware runs (same request, but the resolution we do here happens
    // against the already-mutated registries).
    let slotConfig: SlotOverridesInput = {};
    const slotHeader = c.req.header("X-Slot-Config");
    if (slotHeader) {
      try {
        const decoded = Buffer.from(slotHeader, "base64").toString("utf8");
        const parsed = JSON.parse(decoded);
        if (parsed && typeof parsed === "object")
          slotConfig = parsed as SlotOverridesInput;
      } catch {
        // Malformed header — behave as if no overrides were supplied.
      }
    }

    // Register client-declared custom presets + providers via the shared
    // overlay helper (ref-counted, base-registry-safe).
    const cleanupTransient = applySlotOverlay(ai, slotConfig);

    const allPresets = ai.presetRegistry.listPresets().filter((p) => p.enabled);

    // Resolution chain:
    //   1. Direct preset id match (includes overlay-registered ones)
    //   2. `slot-<name>` → client slotPresetOverrides → slotRegistry
    //   3. Text-tag fallback (mirrors gateway.streamText behaviour)
    //   4. Any enabled preset
    //
    // `resolvedVia` is echoed back in `testedTarget` so the UI can warn
    // when a slot Ping silently fell through to a tag-fallback preset
    // (i.e. the slot the user typed isn't actually configured).
    type ResolvedVia = "direct" | "slot" | "tag-fallback" | "any";
    let resolvedVia: ResolvedVia = "direct";
    let preset = allPresets.find((p) => p.id === requested);
    if (!preset && requested.startsWith("slot-")) {
      const slotName = requested.slice("slot-".length);
      const overrideId = slotConfig.slotPresetOverrides?.[slotName];
      if (overrideId) {
        preset = allPresets.find((p) => p.id === overrideId);
        if (preset) resolvedVia = "slot";
      }
      if (!preset) {
        const presetIdFromSlot = ai.slotRegistry.resolveSlot(slotName);
        if (presetIdFromSlot) {
          preset = allPresets.find((p) => p.id === presetIdFromSlot);
          if (preset) resolvedVia = "slot";
        }
      }
    }
    if (!preset) {
      const textSlots = ai.slotRegistry.listSlotsByTag("text");
      if (textSlots.length > 0) {
        preset = allPresets.find((p) => p.id === textSlots[0].presetId);
        if (preset) resolvedVia = "tag-fallback";
      }
    }
    if (!preset) {
      preset = allPresets[0];
      if (preset) resolvedVia = "any";
    }

    if (!preset) {
      cleanupTransient();
      return c.json({
        ok: false,
        latencyMs: 0,
        error:
          "No LLM provider configured. Add a slot to llm.toml or via Settings.",
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
      presetId: preset.id,
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

    try {
      for await (const event of ai.gateway.streamText(
        { presetId: preset.id, messages: [{ role: "user", content: "hi" }] },
        {
          apiKeys,
          signal: abort.signal,
          slotOverrides: {
            ...(slotConfig.slotPresetOverrides
              ? { slotPresetOverrides: slotConfig.slotPresetOverrides }
              : {}),
            ...(slotConfig.parameterOverrides
              ? { parameterOverrides: slotConfig.parameterOverrides }
              : {}),
          },
        },
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
        const message = err instanceof Error ? err.message : String(err);
        clearTimeout(timeout);
        cleanupTransient();
        return c.json({
          ok: false,
          latencyMs: Date.now() - startedAt,
          ...(ttfbMs !== null ? { ttfbMs } : {}),
          error: message,
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
