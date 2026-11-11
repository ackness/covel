/**
 * Model Database API routes — search, lookup, refresh the LiteLLM model database.
 */

import { Hono } from "hono";
import { writeFileSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { providerApiKeysFromEnv, readRuntimeEnv } from "@covel/shared";
import {
  type ProviderProtocol,
  getProtocolDefinition,
  createModelDatabase,
  fetchLiteLlmModels,
  projectCapabilityForBuiltinAdapter,
  resolveCapabilityDetails,
  resolveReasoningEffortProfile,
  setModelDatabase,
} from "@covel/ai-provider";
import { rateLimiter, singleFlight } from "../middleware/rate-limit.js";
import type { AiStack } from "../ai-setup.js";
import { errorBody, listBody, okBody } from "../api-error.js";
import { requireAccess } from "../host-profile.js";
import { parseSlotOverrides } from "../middleware/per-request-llm.js";
import { hasResolvedRuntimeJobCredentials } from "../runtime-job-readiness.js";

const MAX_SEARCH_LIMIT = 200;

export function createModelDbRoutes(
  ai: AiStack,
  apiKeys: Readonly<Record<string, string>> = providerApiKeysFromEnv(),
): Hono {
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
    if (!ai.modelDb) return c.json(listBody([]));
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
      cacheReadPerMToken: entry.cacheReadPerMToken,
      cacheWritePerMToken: entry.cacheWritePerMToken,
      outputPerMToken: entry.outputPerMToken,
    }));
    return c.json(listBody(results));
  });

  app.get("/api/model-db/lookup", (c) => {
    const model = c.req.query("model") ?? "";
    const provider = c.req.query("provider");
    const protocol = c.req.query("protocol") as ProviderProtocol | undefined;
    const role = c.req.query("role");
    // A browser may ask about its own connection in this existing local lookup.
    // Never trust a server preset's endpoint as the origin of a request target.
    let serverCredentialsAvailable: boolean | undefined;
    if (c.req.query("credentials") === "1") {
      const presets = parseSlotOverrides(
        c.req.header("X-Slot-Config"),
      )?.customPresets;
      const target = presets?.length === 1 ? presets[0] : undefined;
      if (
        !target ||
        target.provider !== provider ||
        target.model !== model ||
        target.protocol !== protocol
      ) {
        return c.json(
          errorBody("Invalid model configuration", {
            code: "invalid_llm_configuration",
          }),
          400,
        );
      }
      serverCredentialsAvailable = false;
      try {
        const resolution = ai.providerRegistry.resolve({
          provider: target.provider,
          baseUrl: target.baseUrl,
          protocol: target.protocol,
          requestScoped: true,
        });
        const resolved = ai.providerRegistry.withApiKeys(
          resolution,
          {},
          target.provider,
          apiKeys,
        );
        serverCredentialsAvailable = hasResolvedRuntimeJobCredentials(
          resolved.config,
        );
      } catch {
        // A missing provider/wire is not evidence that a key can be used.
      }
    }
    const result = resolveCapabilityDetails(
      model,
      provider ?? undefined,
      protocol,
    );
    const usesBuiltinAdapter =
      role &&
      protocol &&
      getProtocolDefinition(protocol) !== undefined &&
      provider &&
      ai.providerRegistry
        ? ai.providerRegistry.resolve({
            provider,
            protocol,
            requestScoped: true,
          }).usesBuiltinAdapter
        : undefined;
    const found = result.source !== "protocol-default";
    return c.json({
      found,
      ...(serverCredentialsAvailable !== undefined
        ? { serverCredentialsAvailable }
        : {}),
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
      capability: result.capability,
      ...(usesBuiltinAdapter !== undefined ? { usesBuiltinAdapter } : {}),
      ...(role && protocol && usesBuiltinAdapter !== false
        ? {
            effectiveCapability: projectCapabilityForBuiltinAdapter(
              result.capability,
              protocol,
              role,
            ),
          }
        : {}),
    });
  });

  app.post(
    "/api/model-db/refresh",
    async (c, next) => {
      const denied = requireAccess(c, "model-db.refresh");
      if (denied) return denied;
      await next();
    },
    rateLimiter({ max: 1 }),
    singleFlight(),
    async (c) => {
      try {
        const freshData = await fetchLiteLlmModels();
        if (ai.modelDb) {
          ai.modelDb.replaceAll(freshData);
        } else {
          const modelDb = createModelDatabase(freshData);
          await modelDb.ready;
          ai.modelDb = modelDb;
        }
        setModelDatabase(ai.modelDb);

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
        return c.json(okBody({ count: ai.modelDb.count, persisted }));
      } catch (err) {
        console.error("[model-db] refresh failed:", err);
        const message = err instanceof Error ? err.message : String(err);
        return c.json(
          errorBody(message, { code: "model_db_refresh_failed" }),
          502,
        );
      }
    },
  );

  return app;
}
