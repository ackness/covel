import type { LLMProviderRequest } from "@covel/shared";
import type { ProviderConfig } from "../../types.js";

// Arbitrary provider metadata may contain credentials. Only protocol fields
// that describe model input/generation are eligible for request traces.
const MODEL_FIELDS = new Set([
  "model",
  "state",
  "questions",
  "messages",
  "input",
  "instructions",
  "system",
  "tools",
  "tool_choice",
  "parallel_tool_calls",
  "response_format",
  "text",
  "temperature",
  "top_p",
  "top_k",
  "max_tokens",
  "max_completion_tokens",
  "max_output_tokens",
  "frequency_penalty",
  "presence_penalty",
  "seed",
  "stop",
  "stream",
  "stream_options",
  "thinking",
  "reasoning",
  "reasoning_effort",
  "enable_thinking",
  "output_config",
  "verbosity",
  "service_tier",
  "store",
]);

/** Detached from the request body: an observer cannot change the sent JSON. */
export function projectRequestBody(serializedBody: string): {
  body: Record<string, unknown>;
  complete: boolean;
  omittedFieldCount: number;
} {
  const raw = JSON.parse(serializedBody) as Record<string, unknown>;
  let complete = true;
  let omittedFieldCount = 0;
  const body: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (MODEL_FIELDS.has(key)) body[key] = value;
    else {
      complete = false;
      omittedFieldCount++;
    }
  }
  // Image/file references can contain signed credentials. Retain ordinary
  // public URLs and data URIs; make redaction explicit rather than claiming a
  // redacted resource can be replayed. Prompt text retains the existing trace
  // privacy contract and must not be treated as a safe public export.
  const sanitized = JSON.stringify(body, (_key, value: unknown) => {
    if (typeof value !== "string" || !/^https?:\/\//i.test(value)) return value;
    try {
      const url = new URL(value);
      if (url.username || url.password || url.search || url.hash) {
        complete = false;
        return "[redacted resource URL]";
      }
    } catch {
      /* Non-URL prompt strings remain data. */
    }
    return value;
  });
  return {
    body: JSON.parse(sanitized) as Record<string, unknown>,
    complete,
    omittedFieldCount,
  };
}

export async function observeJsonRequest(
  observation: ProviderConfig["requestObservation"],
  serializedBody: string,
  transportAttempt: number,
  call: () => Promise<Response>,
): Promise<Response> {
  if (!observation) return call();
  const start = Date.now();
  const record = (
    outcome: Pick<LLMProviderRequest, "statusCode" | "failed">,
  ): void => {
    try {
      observation.onRequest({
        schemaVersion: 1,
        provider: observation.provider,
        protocol: observation.protocol,
        ...projectRequestBody(serializedBody),
        transportAttempt,
        startedAt: new Date(start).toISOString(),
        durationMs: Date.now() - start,
        ...outcome,
      });
    } catch {
      /* Observation must not fail or retry a provider request. */
    }
  };
  try {
    const response = await call();
    record({ statusCode: response.status });
    return response;
  } catch (error) {
    record({ failed: true });
    throw error;
  }
}
