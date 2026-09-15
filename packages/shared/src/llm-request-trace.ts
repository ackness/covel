import type { LLMProviderRequest } from "./types/llm-provider-request.js";

/** A duplicate request refers to an earlier full body in the same trace array. */
export type LLMProviderRequestTrace =
  | LLMProviderRequest
  | (Omit<LLMProviderRequest, "schemaVersion" | "body"> & {
      readonly schemaVersion: 2;
      readonly bodyRef: number;
    });

/** Preserve every attempt's outcome without serializing identical bodies again. */
export function compactProviderRequests(
  requests: readonly LLMProviderRequest[],
): LLMProviderRequestTrace[] {
  if (requests.length < 2) return [...requests];
  const bodies = new Map<string, number>();
  return requests.map((request, index) => {
    let serialized: string;
    try {
      serialized = JSON.stringify(request.body);
    } catch {
      // Custom adapters can emit non-JSON diagnostics. Compaction must not
      // turn an observation failure into a failed or retried model call.
      return request;
    }
    const bodyRef = bodies.get(serialized);
    if (bodyRef === undefined) {
      bodies.set(serialized, index);
      return request;
    }
    const { body: _body, schemaVersion: _version, ...attempt } = request;
    return { ...attempt, schemaVersion: 2, bodyRef };
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Read old full-body traces and new backward-only references without recursion. */
export function resolveProviderRequestBody(
  requests: readonly unknown[],
  index: number,
): Readonly<Record<string, unknown>> | undefined {
  const request = requests[index];
  if (!isRecord(request)) return undefined;
  if (request.schemaVersion === undefined || request.schemaVersion === 1)
    return isRecord(request.body) ? request.body : undefined;
  const bodyRef = request.bodyRef;
  if (
    request.schemaVersion !== 2 ||
    typeof bodyRef !== "number" ||
    !Number.isInteger(bodyRef) ||
    bodyRef < 0 ||
    bodyRef >= index
  )
    return undefined;
  const original = requests[bodyRef];
  return isRecord(original) &&
    (original.schemaVersion === undefined || original.schemaVersion === 1) &&
    isRecord(original.body)
    ? original.body
    : undefined;
}
