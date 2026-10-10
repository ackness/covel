import { afterEach, describe, expect, it, vi } from "vitest";
import {
  assertSuccess,
  MALFORMED_TOOL_ARGUMENTS,
} from "../src/adapters/http/response.js";
import { providerErrorKind } from "../src/adapters/provider-error-kind.js";
import { AiProviderError, OutboundFetchError } from "../src/errors.js";
import { normalizeError } from "../src/gateway-lifecycle.js";
import { outboundFetch } from "../src/outbound-network.js";

describe("gateway transport error normalization", () => {
  it.each([
    new TypeError("fetch failed"),
    new Error("request failed", {
      cause: Object.assign(new Error("connection interrupted"), {
        code: "ECONNRESET",
      }),
    }),
    Object.assign(new Error("socket closed"), { code: "UND_ERR_SOCKET" }),
  ])("marks known transport failures retriable: %s", (error) => {
    const normalized = normalizeError(error, "fixture");
    expect(normalized).toMatchObject({
      code: "PROVIDER_ERROR",
      retriable: true,
      cause: error,
    });
  });

  it.each([
    new Error("network option is unsupported"),
    new Error("unexpected failure"),
    Object.assign(new Error("certificate rejected"), {
      code: "CERT_HAS_EXPIRED",
    }),
    new RangeError("invalid timeout option"),
    new DOMException("deadline reached", "TimeoutError"),
    new DOMException("caller cancelled", "AbortError"),
  ])("does not infer transport failures from arbitrary prose: %s", (error) => {
    expect(normalizeError(error, "fixture").retriable).toBe(false);
  });

  it.each([
    { code: "PROVIDER_ERROR", statusCode: 400 },
    { code: "CONFIG_ERROR" },
    { code: "SCHEMA_VALIDATION_FAILED" },
  ] as const)("preserves an existing $code classification", (fields) => {
    const error = new AiProviderError({
      ...fields,
      provider: "fixture",
      message: "network option is unsupported",
      retriable: false,
      cause: new TypeError("fetch failed"),
    });
    expect(normalizeError(error, "fixture")).toBe(error);
  });
});

describe("errors typed where they start", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("turns the platform's bare fetch failure into OutboundFetchError", async () => {
    const refused = new TypeError("fetch failed", {
      cause: Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:9"), {
        code: "ECONNREFUSED",
      }),
    });
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(refused));
    const failure = await outboundFetch("https://provider.example/v1", {
      method: "GET",
    }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(OutboundFetchError);
    expect(failure).toMatchObject({ code: "ECONNREFUSED", cause: refused });
    expect(normalizeError(failure, "fixture").retriable).toBe(true);

    // Another TypeError of `fetch` is a fault of the request, not of the link.
    const invalid = new TypeError("Invalid URL");
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(invalid));
    await expect(
      outboundFetch("https://provider.example/v1", { method: "GET" }),
    ).rejects.toBe(invalid);
  });

  it("throws an HTTP failure as AiProviderError with the provider's fields", () => {
    const thrown = (status: number, error: Record<string, unknown>) => {
      try {
        assertSuccess(new Response("", { status }), { error }, "openai-chat");
      } catch (caught) {
        return caught;
      }
      return undefined;
    };
    const quota = thrown(429, {
      code: "insufficient_quota",
      type: "insufficient_quota",
      message: "You exceeded your current quota",
    });
    expect(quota).toBeInstanceOf(AiProviderError);
    expect(quota).toMatchObject({
      code: "RATE_LIMITED",
      statusCode: 429,
      message: "[openai-chat] HTTP 429 — You exceeded your current quota",
      details: { providerCode: "insufficient_quota" },
    });

    const malformed = thrown(400, {
      type: "invalid_request_error",
      message:
        'The "function.arguments" parameter of the code model must be in JSON format.',
    });
    expect(malformed).toMatchObject({
      details: { requestFault: MALFORMED_TOOL_ARGUMENTS },
    });
    // The same words under another status are not that fault.
    const other = thrown(500, {
      message: "function.arguments must be in JSON format",
    }) as AiProviderError;
    expect(other.details?.requestFault).toBeUndefined();
  });

  it("classifies a provider's error code by table, then by fragment", () => {
    expect(providerErrorKind("insufficient_quota")).toBe("quota");
    expect(providerErrorKind(undefined, "authentication_error")).toBe("auth");
    expect(providerErrorKind("PERMISSION_DENIED")).toBe("auth");
    expect(providerErrorKind("data_inspection_content_filter")).toBe("refusal");
    // The code wins over the type when both are known.
    expect(
      providerErrorKind("context_length_exceeded", "authentication_error"),
    ).toBe("invalid_request");
    expect(providerErrorKind("rate_limit_exceeded", "server_error")).toBe(
      undefined,
    );
  });
});
