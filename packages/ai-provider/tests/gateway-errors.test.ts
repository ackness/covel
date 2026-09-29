import { describe, expect, it } from "vitest";
import { AiProviderError } from "../src/errors.js";
import { normalizeError } from "../src/gateway-lifecycle.js";

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
