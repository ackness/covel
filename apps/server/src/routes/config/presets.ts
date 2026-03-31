import { Hono } from "hono";
import type { AiStack } from "../../ai-setup.js";

/**
 * GET /api/config/presets
 *
 * Returns the list of available presets (no secrets).
 */
export function createPresetsRoute(ai: AiStack) {
  const route = new Hono();

  route.get("/", (c) => {
    const presets = ai.presetRegistry.listPresets().map((p) => ({
      id: p.id,
      name: p.name,
      provider: p.provider,
      model: p.model,
      tier: p.tier,
      supportedModes: p.supportedModes,
      enabled: p.enabled,
      isDefault: p.isDefault ?? false,
    }));

    return c.json({ presets });
  });

  return route;
}
