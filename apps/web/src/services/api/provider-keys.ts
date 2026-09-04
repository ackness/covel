import { z } from "zod";
import { getDesktopRestAuthHeaders } from "@/lib/desktop-bridge.js";
import { request } from "./request.js";

const providerKeysResponseSchema = z
  .object({
    keys: z.record(z.string(), z.string()),
  })
  .strict();

/**
 * Read raw server-managed keys when the desktop bearer permits it. Hosted and
 * ordinary web deployments return an empty map or reject the optional probe.
 */
export async function fetchServerProviderKeys(): Promise<
  Record<string, string>
> {
  const response = await request("/api/provider-keys", {
    headers: getDesktopRestAuthHeaders(),
    operatorAuth: true,
    silentErrors: true,
    schema: providerKeysResponseSchema,
  });
  return response.keys;
}
