/**
 * Model Database API routes — search, lookup, refresh the LiteLLM model database.
 */

import { Hono } from "hono";
import { writeFileSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { readRuntimeEnv } from "@covel/shared";
import {
  resolveCapabilityDetails,
  resolveReasoningEffortProfile,
} from "@covel/ai-provider";
import { rateLimiter, singleFlight } from "../middleware/rate-limit.js";
import type { AiStack } from "../ai-setup.js";
import { checkHostedOperator } from "./api/session/session-guard.js";

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
    const model = c.req.query("model") ?? "";
    const provider = c.req.query("provider");
    const protocol = c.req.query("protocol") as
      | "openai-chat-v1"
      | "openai-responses-v1"
      | "anthropic-messages-v1"
      | undefined;
    const result = resolveCapabilityDetails(
      model,
      provider ?? undefined,
      protocol,
    );
    const found = result.source !== "protocol-default";
    return c.json({
      found,
      source: result.source,
      matchedModelId: result.matchedModelId,
      matchKind: result.matchKind,
      pricingKind: result.pricingKind,
      candidates: result.candidates,
      reasoning: resolveReasoningEffortProfile(
        model,
        provider,
        protocol,
        result.capability.features,
      ),
      capability: {
        ...result.capability,
        inputPerMToken: result.capability.pricing?.inputPerMToken,
        outputPerMToken: result.capability.pricing?.outputPerMToken,
      },
    });
  });

  app.post(
    "/api/model-db/refresh",
    async (c, next) => {
      const denied = checkHostedOperator(c);
      if (denied) return denied;
      await next();
    },
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
        console.error("[model-db] refresh failed:", err);
        const message = err instanceof Error ? err.message : String(err);
        return c.json({ ok: false, error: message });
      }
    },
  );

  return app;
}
