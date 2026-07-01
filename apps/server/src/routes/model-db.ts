/**
 * Model Database API routes — search, lookup, refresh the LiteLLM model database.
 */

import { Hono } from "hono";
import { writeFileSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { readRuntimeEnv } from "@covel/shared";
import { rateLimiter, singleFlight } from "../middleware/rate-limit.js";
import type { AiStack } from "../ai-setup.js";

const MAX_SEARCH_LIMIT = 200;

export function createModelDbRoutes(ai: AiStack): Hono {
  const app = new Hono();

  app.get("/api/model-db", (c) => {
    if (!ai.modelDb) {
      return c.json({ available: false });
    }
    const info = ai.modelDb.getInfo();
    return c.json({
      available: true,
      updatedAt: info?.updatedAt,
      count: info?.count ?? ai.modelDb.count,
      source: info?.source,
    });
  });

  app.get("/api/model-db/search", (c) => {
    if (!ai.modelDb) return c.json({ results: [] });
    const q = c.req.query("q") ?? "";
    const rawLimit = parseInt(c.req.query("limit") ?? "20", 10);
    const limit = Number.isNaN(rawLimit)
      ? 20
      : Math.min(Math.max(1, rawLimit), MAX_SEARCH_LIMIT);
    const results = ai.modelDb.search(q, limit).map(({ id, entry }) => ({
      id,
      provider: entry.litellmProvider,
      contextWindow: entry.contextWindow,
      maxOutputTokens: entry.maxOutputTokens,
      inputPerMToken: entry.inputPerMToken,
      outputPerMToken: entry.outputPerMToken,
    }));
    return c.json({ results });
  });

  app.get("/api/model-db/lookup", (c) => {
    if (!ai.modelDb) return c.json({ found: false });
    const model = c.req.query("model") ?? "";
    const provider = c.req.query("provider");
    const entry = ai.modelDb.lookup(model, provider ?? undefined);
    if (!entry) return c.json({ found: false });
    const cap = ai.modelDb.toCapability(entry);
    return c.json({
      found: true,
      capability: {
        contextWindow: cap.contextWindow,
        maxOutputTokens: cap.maxOutputTokens,
        inputPerMToken: entry.inputPerMToken,
        outputPerMToken: entry.outputPerMToken,
      },
    });
  });

  app.post(
    "/api/model-db/refresh",
    rateLimiter({ max: 1 }),
    singleFlight(),
    async (c) => {
      if (!ai.modelDb)
        return c.json({ ok: false, error: "Model database not available" });
      try {
        const { fetchLiteLlmModels } = await import("@covel/ai-provider");
        const freshData = await fetchLiteLlmModels();
        ai.modelDb.replaceAll(freshData);

        // Persist to the user config dir so the refresh survives restarts.
        // Non-fatal if the disk write fails — the in-memory DB is still updated.
        const userConfigDir = readRuntimeEnv().userConfigDir;
        let persisted = false;
        if (userConfigDir) {
          try {
            const target = resolve(userConfigDir, "model-db.json");
            mkdirSync(dirname(target), { recursive: true });
            writeFileSync(target, JSON.stringify(freshData, null, 2), "utf-8");
            persisted = true;
          } catch (err) {
            console.warn("[model-db] persist failed:", err);
          }
        }
        return c.json({ ok: true, count: ai.modelDb.count, persisted });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return c.json({ ok: false, error: message });
      }
    },
  );

  return app;
}
