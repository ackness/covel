/**
 * Per-request LLM adapter middleware.
 *
 * Parses the two request-scoped configuration headers sent by the
 * browser:
 *
 *   - `X-Provider-Keys`  base64 JSON  →  `{ [provider]: apiKey }`
 *   - `X-Slot-Config`    base64 JSON  →  `{ slotPresetOverrides?, customPresets? }`
 *
 * and, when either is present, swaps `c.get('llmAdapter')` for a
 * request-scoped adapter that forwards these through the gateway. This
 * lets browser-only custom slots (e.g. `covel.fast`) participate in
 * real turn execution instead of silently falling back to the first
 * text slot configured in llm.toml.
 *
 * Keys are never written to disk or process memory beyond the scope of
 * a single request. API keys provided by the browser win over any
 * server-side environment keys so the UI can override per session.
 *
 * When neither header is present the middleware is a no-op and the
 * base-startup `llmAdapter` stays in place.
 */

import type { MiddlewareHandler } from 'hono';
import { createGatewayAdapter } from '@covel/runtime';
import type { AiStack } from '../ai-setup.js';
import type { SlotOverridesInput } from '@covel/ai-provider';

export interface PerRequestLlmOptions {
  readonly ai: AiStack;
  /** Base API keys from process.env (*_API_KEY). Client keys override. */
  readonly envApiKeys: Record<string, string>;
  /**
   * The adapter produced at server startup. Used as a fallback when the
   * request has no overriding headers so callers can keep relying on
   * `c.get('llmAdapter')` without null checks.
   */
  readonly defaultLlmAdapter: import('@covel/runtime').LLMAdapter;
}

const MAX_HEADER_BYTES = 64 * 1024; // sanity cap — browsers rarely send bigger

export function createPerRequestLlmMiddleware(
  opts: PerRequestLlmOptions,
): MiddlewareHandler {
  return async (c, next) => {
    const requestKeys = parseProviderKeys(c.req.header('X-Provider-Keys'));
    const slotOverrides = parseSlotOverrides(c.req.header('X-Slot-Config'));

    const hasRequestKeys =
      requestKeys !== null && Object.keys(requestKeys).length > 0;
    const hasOverrides =
      slotOverrides !== null &&
      ((slotOverrides.customPresets?.length ?? 0) > 0 ||
        Object.keys(slotOverrides.slotPresetOverrides ?? {}).length > 0);

    if (!hasRequestKeys && !hasOverrides) {
      await next();
      return;
    }

    const mergedApiKeys: Record<string, string> = {
      ...opts.envApiKeys,
      ...(requestKeys ?? {}),
    };

    const perRequestAdapter = createGatewayAdapter(opts.ai.gateway, {
      apiKeys: mergedApiKeys,
      ...(slotOverrides ? { slotOverrides } : {}),
    });

    c.set('llmAdapter', perRequestAdapter);
    await next();
  };
}

function parseProviderKeys(
  header: string | undefined,
): Record<string, string> | null {
  if (!header || header.length > MAX_HEADER_BYTES) return null;
  try {
    const decoded = Buffer.from(header, 'base64').toString('utf8');
    const parsed = JSON.parse(decoded);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const result: Record<string, string> = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof v === 'string' && v.length > 0) result[k] = v;
    }
    return result;
  } catch {
    return null;
  }
}

function parseSlotOverrides(
  header: string | undefined,
): SlotOverridesInput | null {
  if (!header || header.length > MAX_HEADER_BYTES) return null;
  try {
    const decoded = Buffer.from(header, 'base64').toString('utf8');
    const parsed = JSON.parse(decoded);
    if (!parsed || typeof parsed !== 'object') return null;
    const out: SlotOverridesInput = {};
    const slotMap = (parsed as Record<string, unknown>).slotPresetOverrides;
    if (slotMap && typeof slotMap === 'object' && !Array.isArray(slotMap)) {
      const clean: Record<string, string> = {};
      for (const [k, v] of Object.entries(slotMap as Record<string, unknown>)) {
        if (typeof k === 'string' && typeof v === 'string' && v.length > 0) {
          clean[k] = v;
        }
      }
      if (Object.keys(clean).length > 0) out.slotPresetOverrides = clean;
    }
    const customPresets = (parsed as Record<string, unknown>).customPresets;
    if (Array.isArray(customPresets)) {
      const clean: SlotOverridesInput['customPresets'] = [];
      for (const raw of customPresets) {
        if (!raw || typeof raw !== 'object') continue;
        const r = raw as Record<string, unknown>;
        if (
          typeof r.id === 'string' &&
          r.id.length > 0 &&
          typeof r.provider === 'string' &&
          r.provider.length > 0 &&
          typeof r.model === 'string' &&
          r.model.length > 0
        ) {
          clean.push({
            id: r.id,
            name: typeof r.name === 'string' ? r.name : r.id,
            provider: r.provider,
            model: r.model,
            ...(typeof r.baseUrl === 'string' ? { baseUrl: r.baseUrl } : {}),
            ...(typeof r.protocol === 'string'
              ? { protocol: r.protocol as SlotOverridesInput['customPresets'] extends Array<infer T>
                  ? T extends { protocol?: infer P } ? P : never : never }
              : {}),
          });
        }
      }
      if (clean.length > 0) out.customPresets = clean;
    }
    return out;
  } catch {
    return null;
  }
}
