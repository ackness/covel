import type { ProviderConfig } from "../types.js";
import { assertSuccess, getJson, parseJson } from "./http.js";

/**
 * Read the model IDs an endpoint lists. It accepts the OpenAI and Anthropic
 * shape (`data: [{ id }]`) and the Gemini shape (`models: [{ name }]`, with
 * the `models/` prefix a request does not carry).
 */
export async function fetchModelIds(
  config: ProviderConfig,
  path: string,
  provider: string,
  signal?: AbortSignal,
  headers?: Record<string, string>,
): Promise<string[]> {
  const response = await getJson(config, path, signal, headers);
  const payload = await parseJson(response);
  assertSuccess(response, payload, provider);
  const rows: unknown[] = Array.isArray(payload.data)
    ? payload.data
    : Array.isArray(payload.models)
      ? payload.models
      : [];
  const ids = new Set<string>();
  for (const row of rows) {
    const entry =
      row !== null && typeof row === "object"
        ? (row as Record<string, unknown>)
        : undefined;
    const id = typeof row === "string" ? row : (entry?.id ?? entry?.name);
    if (typeof id === "string" && id.trim())
      ids.add(id.trim().replace(/^models\//, ""));
  }
  return [...ids].sort((left, right) => left.localeCompare(right, "en"));
}
