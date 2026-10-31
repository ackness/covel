import { describe, expect, it } from "vitest";
import { Hono } from "hono";
import {
  assertPrivateActorComposition,
  compositionScenarios,
} from "../../../../packages/runtime/tests/_helpers/actor-agent-composition.js";
import { traceRoutes } from "../../src/routes/api/traces.js";

describe.each([false, true])(
  "delegation trace API (concealed: %s)",
  (concealed) => {
    it.each(compositionScenarios)(
      "protects private context with %s",
      async (scenario) => {
        await assertPrivateActorComposition({
          concealed,
          scenario,
          inspectTrace: async (store, sessionId) => {
            const app = new Hono();
            app.use("*", async (c, next) => {
              c.set("store", store);
              c.set("builtinToolNames", ["delegate"]);
              await next();
            });
            app.route("/api/traces", traceRoutes);
            for (const suffix of ["", "/turns", "/turns/page"]) {
              const response = await app.request(
                `/api/traces/${sessionId}${suffix}`,
              );
              expect(response.status).toBe(200);
              const body = await response.text();
              expect(body).toContain("llm.calling");
              expect(body).not.toMatch(
                /INTENT-SECRET|BRIEF-SECRET|PRIVATE-REASONING/,
              );
              if (scenario === "compacted")
                expect(body).toContain("Earlier tool steps");
            }
          },
        });
      },
    );
  },
);
