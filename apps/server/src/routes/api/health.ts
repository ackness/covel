/**
 * API Health check route.
 *
 * The backend name is injected by the bootstrap layer rather than read from
 * `process.env` directly — this guarantees the value reflects the store that
 * was actually instantiated, even if the env var was overridden after boot.
 *
 * Vector statistics are pulled live from the store on every request via
 * `listVectorModels()` so the response surfaces real counts instead of
 * placeholders.
 */

import { Hono } from "hono";
import { APP_VERSION } from "../../lib/app-version.js";
import type {
  DataStore,
  MediaStore,
  MediaStoreBackend,
  StoreBackend,
  VectorBackend,
} from "@covel/store";
import { describeStorageCapabilities } from "@covel/store/capabilities";
import { hostProfileOf } from "../../host-profile.js";

const bootId = crypto.randomUUID();

/** Where the running build came from, as the operator configured it. */
export interface HealthSourceInput {
  readonly repository?: string;
  readonly commit?: string;
}

const COMMIT_PATTERN = /^[0-9a-f]{7,40}$/i;

/**
 * The source facts worth showing a player: an https repository address and a
 * hex commit. Anything else is dropped rather than echoed.
 */
export function describeHealthSource(
  input: HealthSourceInput,
): { repository?: string; commit?: string } | undefined {
  let repository: string | undefined;
  if (input.repository) {
    try {
      const url = new URL(input.repository.trim());
      if (url.protocol === "https:" && !url.username && !url.password) {
        repository = url.href.replace(/\/+$/, "");
      }
    } catch {
      /* Not a URL: leave it out. */
    }
  }
  const trimmedCommit = input.commit?.trim();
  const commit =
    trimmedCommit && COMMIT_PATTERN.test(trimmedCommit)
      ? trimmedCommit.toLowerCase()
      : undefined;
  if (!repository && !commit) return undefined;
  return {
    ...(repository ? { repository } : {}),
    ...(commit ? { commit } : {}),
  };
}

export function createHealthRoutes(
  store: DataStore,
  backend: StoreBackend,
  options: {
    readonly mediaBackend?: MediaStoreBackend;
    readonly mediaStore?: MediaStore;
    readonly vectorBackend?: VectorBackend;
    readonly source?: HealthSourceInput;
  } = {},
): Hono {
  const app = new Hono();
  const source = describeHealthSource(options.source ?? {});

  // GET /health — Health check
  app.get("/", async (c) => {
    const storage = await describeStorageCapabilities({
      dataBackend: backend,
      mediaBackend: options.mediaBackend,
      mediaStore: options.mediaStore,
      vectorBackend: options.vectorBackend,
      store,
    });

    const form = hostProfileOf(c).form;
    return c.json({
      status: "ok",
      version: APP_VERSION,
      bootId,
      timestamp: new Date().toISOString(),
      // Lets a client offer the operator token entry only where one is checked.
      operatorTokenRequired: form !== "personal",
      // Lets a client tell players on a shared server where their data and
      // keys go, and which code serves them.
      deployment: { form, ...(source ? { source } : {}) },
      storage,
      vector: storage.vector,
    });
  });

  return app;
}
