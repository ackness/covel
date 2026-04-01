import { Hono } from "hono";
import type { AiStack } from "../../ai-setup.js";

/**
 * Frontend-compatible GET /presets and PATCH /presets/:id
 * Returns PresetSummary[] = [{ id, name, provider, model, enabled, isDefault, scope }]
 */
export function createCompatPresetsRoute(ai: AiStack) {
  const route = new Hono();

  route.get("/", (c) => {
    const presets = ai.presetRegistry.listPresets().map((p) => ({
      id: p.id,
      name: p.name,
      provider: p.provider,
      model: p.model,
      enabled: p.enabled,
      isDefault: p.isDefault ?? false,
      scope: "global",
    }));
    return c.json(presets);
  });

  route.patch("/:presetId", async (c) => {
    // Stub — frontend may call this but we don't persist preset changes yet
    const presetId = c.req.param("presetId");
    const body = await c.req.json();
    return c.json({ id: presetId, ...body });
  });

  return route;
}
