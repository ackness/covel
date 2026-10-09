import { describe, expect, it } from "vitest";
import { LLMRequestBudgetError } from "@covel/shared";

import { AiProviderError } from "../src/errors.js";
import { classifyProviderFailure } from "../src/provider-failure.js";

/** The shape `assertSuccess` throws for a non-2xx provider answer. */
function httpFailure(
  statusCode: number,
  details: Record<string, unknown> = {},
) {
  return new Error(
    JSON.stringify({
      name: "AiProviderError",
      code: statusCode === 429 ? "RATE_LIMITED" : "PROVIDER_ERROR",
      provider: "openai-chat",
      retriable: false,
      statusCode,
      details,
    }),
  );
}

function fetchFailed(code: string, message: string) {
  return new TypeError("fetch failed", {
    cause: Object.assign(new Error(message), { code }),
  });
}

describe("classifyProviderFailure", () => {
  it.each([
    [401, {}, "auth"],
    [403, {}, "auth"],
    [404, {}, "not_found"],
    [400, {}, "bad_request"],
    [429, {}, "rate_limited"],
    [500, {}, "server"],
    [503, {}, "overloaded"],
    [529, {}, "overloaded"],
    [504, {}, "timeout"],
    // An empty account comes back under three different statuses.
    [429, { providerCode: "insufficient_quota" }, "quota"],
    [402, { message: "Insufficient Balance" }, "quota"],
    [400, { message: "Your credit balance is too low" }, "quota"],
  ])("reads HTTP %i %j as %s", (statusCode, details, kind) => {
    expect(
      classifyProviderFailure(httpFailure(statusCode, details)),
    ).toMatchObject({ kind, statusCode });
  });

  it("names the host and port of a connection that failed", () => {
    expect(
      classifyProviderFailure(
        fetchFailed("ECONNREFUSED", "connect ECONNREFUSED 127.0.0.1:11434"),
      ),
    ).toEqual({
      kind: "unreachable",
      message: "connect ECONNREFUSED 127.0.0.1:11434",
    });
    expect(
      classifyProviderFailure(
        fetchFailed("ENOTFOUND", "getaddrinfo ENOTFOUND api.example.invalid"),
      ).kind,
    ).toBe("unreachable");
    expect(
      classifyProviderFailure(
        fetchFailed("DEPTH_ZERO_SELF_SIGNED_CERT", "self-signed certificate"),
      ).kind,
    ).toBe("unreachable");
  });

  it("separates a timeout, a refusal and a configuration fault", () => {
    expect(
      classifyProviderFailure(
        fetchFailed("UND_ERR_HEADERS_TIMEOUT", "Headers Timeout Error"),
      ).kind,
    ).toBe("timeout");
    expect(
      classifyProviderFailure(new DOMException("timed out", "TimeoutError"))
        .kind,
    ).toBe("timeout");
    expect(
      classifyProviderFailure(new LLMRequestBudgetError("deadline")).kind,
    ).toBe("timeout");
    expect(
      classifyProviderFailure(
        new AiProviderError({
          code: "REFUSAL",
          message: "refused",
          provider: "p",
          retriable: false,
        }),
      ).kind,
    ).toBe("refused");
    expect(
      classifyProviderFailure(
        new Error('Provider error: baseUrl "http://10.0.0.1" is not allowed.'),
      ).kind,
    ).toBe("config");
    expect(classifyProviderFailure(new Error("something else")).kind).toBe(
      "unknown",
    );
  });
});
