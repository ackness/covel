import { Hono } from "hono";
import type { ModelDatabase } from "@covel/ai-provider";
import { fetchLiteLlmModels } from "@covel/ai-provider";

/**
 * Model database API routes.
 *
 * GET  /api/model-db              — DB info (updatedAt, count)
 * GET  /api/model-db/search?q=... — Search models by name (returns up to 20)
 * GET  /api/model-db/lookup?model=...&provider=... — Look up a single model
 * POST /api/model-db/refresh      — Refresh from GitHub (fetches latest LiteLLM data)
 */
export function createModelDbRoute(modelDb: ModelDatabase | null) {
  const route = new Hono();

  route.get("/", (c) => {
    if (!modelDb) return c.json({ available: false });
    return c.json({ available: true, ...modelDb.getInfo() });
  });

  route.get("/search", (c) => {
    if (!modelDb) return c.json({ results: [] });
    const q = c.req.query("q") ?? "";
    const rawLimit = parseInt(c.req.query("limit") ?? "20", 10);
    const limit = Math.min(Number.isNaN(rawLimit) ? 20 : rawLimit, 100);
    if (!q.trim()) return c.json({ results: [] });

    const results = modelDb.search(q, limit).map(({ id, entry }) => ({
      id,
      input: entry.input,
      output: entry.output,
      features: entry.features,
      contextWindow: entry.contextWindow,
      maxOutputTokens: entry.maxOutputTokens,
      mode: entry.mode,
      inputPerMToken: entry.inputPerMToken,
      outputPerMToken: entry.outputPerMToken,
    }));

    return c.json({ results });
  });

  route.get("/lookup", (c) => {
    if (!modelDb) return c.json({ found: false });
    const model = c.req.query("model");
    const provider = c.req.query("provider");
    if (!model) return c.json({ found: false, error: "missing ?model= parameter" }, 400);

    const entry = modelDb.lookup(model, provider ?? undefined);
    if (!entry) return c.json({ found: false });

    return c.json({ found: true, capability: modelDb.toCapability(entry) });
  });

  route.post("/refresh", async (c) => {
    // Only allow refresh in self-hosted tier or with explicit env opt-in
    const tier = process.env.DEPLOYMENT_TIER ?? "self";
    if (tier !== "self" && process.env.ALLOW_MODEL_DB_REFRESH !== "true") {
      return c.json({ ok: false, error: "Model database refresh is not allowed in this deployment tier" }, 403);
    }

    if (!modelDb) {
      return c.json({ ok: false, error: "Model database not initialized" }, 500);
    }

    try {
      const freshData = await fetchLiteLlmModels();
      modelDb.replaceAll(freshData);
      await modelDb.persist();
      return c.json({
        ok: true,
        updatedAt: freshData.updatedAt,
        count: freshData.count,
      });
    } catch (err) {
      return c.json({
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      }, 500);
    }
  });

  return route;
}
