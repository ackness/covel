import type { ApiBootstrapResult } from "../../src/routes/api/bootstrap.js";
import { createServerResourceDrain } from "../../src/server-resources.js";

/** Drain host-created work; each fixture still owns its injected store. */
export async function closeTestApi(
  api: ApiBootstrapResult | undefined,
): Promise<void> {
  if (api) await createServerResourceDrain({ api, worldWatchers: [] })();
}
