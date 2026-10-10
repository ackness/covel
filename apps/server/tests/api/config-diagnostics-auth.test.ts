import { afterEach, describe, expect, it, vi } from "vitest";
import { createPluginRegistry } from "@covel/plugin-loader";
import { createMemoryStore } from "@covel/store/memory";
import { createAiStack } from "../../src/ai-setup.js";
import { createConfigApiRoutes } from "../../src/routes/config-api.js";
import { createMiscApiRoutes } from "../../src/routes/misc-api.js";

afterEach(() => vi.unstubAllEnvs());

describe.each(["demo", "commercial"])(
  "%s configuration diagnostics",
  (tier) => {
    it("retains the public boot catalog without disclosing administrator paths or parser errors", async () => {
      vi.stubEnv("DEPLOYMENT_TIER", tier);
      vi.stubEnv("COVEL_DESKTOP_REST_TOKEN", "synthetic-operator");
      vi.stubEnv("SQLITE_PATH", "/private/synthetic-host/covel.db");
      vi.stubEnv("COVEL_LLM_TOML", "/private/synthetic-host/llm.toml");
      const ai = createAiStack();
      ai.lastLoadError =
        "Synthetic parse failure at /private/synthetic-host/llm.toml";
      const store = createMemoryStore();
      const misc = createMiscApiRoutes(ai, createPluginRegistry(), store);
      const config = createConfigApiRoutes({ apiKeys: {} });
      try {
        const headerSets: Record<string, string>[] = [
          {},
          { Authorization: "Bearer wrong-token" },
        ];
        for (const headers of headerSets) {
          const publicConfig = await config.request("/api/config/info", {
            headers,
          });
          expect(publicConfig.status).toBe(200);
          expect(await publicConfig.json()).toMatchObject({
            isDesktop: false,
            requiresAuth: true,
            dbPath: null,
            llmTomlPath: null,
          });
          const publicLlm = await misc.request("/api/llm-config", { headers });
          const body = await publicLlm.json();
          expect(body).toMatchObject({ configured: true });
          expect(Object.keys(body.slots).length).toBeGreaterThan(0);
          expect(body).not.toHaveProperty("source");
          expect(body).not.toHaveProperty("error");
          expect(JSON.stringify(body)).not.toContain("/private/synthetic-host");
        }
        const headers = { Authorization: "Bearer synthetic-operator" };
        expect(
          await (await config.request("/api/config/info", { headers })).json(),
        ).toMatchObject({ dbPath: "/private/synthetic-host/covel.db" });
        expect(
          await (await misc.request("/api/llm-config", { headers })).json(),
        ).toMatchObject({
          source: { path: "/private/synthetic-host/llm.toml" },
          error: ai.lastLoadError,
        });
        expect(
          (await misc.request("/api/llm-config/reload", { method: "POST" }))
            .status,
        ).toBe(401);
      } finally {
        await store.close();
      }
    });
  },
);
