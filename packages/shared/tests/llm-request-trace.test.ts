import { expect, it } from "vitest";
import {
  compactProviderRequests,
  resolveProviderRequestBody,
} from "../src/llm-request-trace.js";
import type { LLMProviderRequest } from "../src/types/llm-provider-request.js";

const request: LLMProviderRequest = {
  schemaVersion: 1,
  provider: "fixture",
  protocol: "openai-chat-v1",
  body: { messages: [{ role: "user", content: "x".repeat(100_000) }] },
  complete: true,
  omittedFieldCount: 0,
  transportAttempt: 0,
  startedAt: "2026-09-15T00:00:00.000Z",
  durationMs: 10,
  statusCode: 429,
};

it("stores repeated bodies once while retaining and reconstructing every attempt", () => {
  const requests = [
    request,
    { ...request, transportAttempt: 1 },
    { ...request, transportAttempt: 2, statusCode: 200 },
  ];
  const compacted = compactProviderRequests(requests);
  const restored = JSON.parse(JSON.stringify(compacted)) as unknown[];
  for (const [index, original] of requests.entries()) {
    expect(resolveProviderRequestBody(restored, index)).toEqual(original.body);
    expect(restored[index]).toMatchObject({
      transportAttempt: index,
      statusCode: original.statusCode,
    });
  }
  expect(JSON.stringify(compacted).length).toBeLessThan(
    JSON.stringify(requests).length / 2,
  );
  expect(request.body.messages).toHaveLength(1);
});

it("preserves distinct fallback bodies and the historical full-body format", () => {
  const fallback = {
    ...request,
    provider: "backup",
    body: { messages: [], model: "other" },
  };
  const compacted = compactProviderRequests([request, fallback, fallback]);
  expect(resolveProviderRequestBody(compacted, 2)).toEqual(fallback.body);
  expect(resolveProviderRequestBody([{ body: request.body }], 0)).toEqual(
    request.body,
  );
});

it("does not throw for non-JSON observations from custom adapters", () => {
  const body: Record<string, unknown> = {};
  body.self = body;
  expect(compactProviderRequests([{ ...request, body }, request])).toHaveLength(
    2,
  );
});

it("rejects unsupported body formats, including referenced bodies", () => {
  const requests = [
    { ...request, schemaVersion: 3 },
    { schemaVersion: 2, bodyRef: 0 },
  ];
  expect(resolveProviderRequestBody(requests, 0)).toBeUndefined();
  expect(resolveProviderRequestBody(requests, 1)).toBeUndefined();
});

it.each([-1, 1, 2, 0.5, "0"])(
  "rejects invalid reference %s without following a chain",
  (bodyRef) => {
    expect(
      resolveProviderRequestBody([request, { schemaVersion: 2, bodyRef }], 1),
    ).toBeUndefined();
    expect(
      resolveProviderRequestBody(
        [
          request,
          { schemaVersion: 2, bodyRef: 0 },
          { schemaVersion: 2, bodyRef: 1 },
        ],
        2,
      ),
    ).toBeUndefined();
  },
);
