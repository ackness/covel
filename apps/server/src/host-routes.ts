import type { Hono } from "hono";
import type { DataStore } from "@covel/store";
import type { AiStack } from "./ai-setup.js";
import type { ApiBootstrapResult } from "./routes/api/bootstrap.js";
import { createModelDbRoutes } from "./routes/model-db.js";
import { createMiscApiRoutes } from "./routes/misc-api.js";
import { createConfigApiRoutes } from "./routes/config-api.js";
import { createRawConfigApiRoutes } from "./routes/raw-config-api.js";
import { createAppUpdateRoutes } from "./routes/app-update.js";

export interface HostRouteDeps {
  readonly api: Pick<ApiBootstrapResult, "app" | "registry">;
  readonly ai: AiStack;
  readonly store: DataStore;
  /** Mutable map shared with the gateway adapter. */
  readonly apiKeys: Record<string, string>;
  /** Captured before keys.env is merged. */
  readonly externalApiKeys?: Readonly<Record<string, string>>;
}

/**
 * Mount every API route module on the host app. `app.ts` and the route access
 * test (`tests/bootstrap/route-access.test.ts`) share this function, so the
 * test sees every route the server serves and the access each one asks of the
 * host profile.
 */
export function mountApiRoutes(app: Hono, deps: HostRouteDeps): void {
  app.route("/", deps.api.app);
  app.route("/", createModelDbRoutes(deps.ai));
  app.route(
    "/",
    createMiscApiRoutes(deps.ai, deps.api.registry, deps.store, deps.apiKeys),
  );
  app.route(
    "/",
    createConfigApiRoutes({
      apiKeys: deps.apiKeys,
      ...(deps.externalApiKeys
        ? { externalApiKeys: deps.externalApiKeys }
        : {}),
    }),
  );
  app.route("/", createRawConfigApiRoutes({ ai: deps.ai }));
  app.route("/", createAppUpdateRoutes());
}
