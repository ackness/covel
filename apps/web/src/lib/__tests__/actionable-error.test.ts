import { describe, expect, it } from "vitest";
import { classifyActionableError } from "../actionable-error.js";

describe("classifyActionableError", () => {
  it("turns provider authentication responses into an actionable category", () => {
    expect(
      classifyActionableError(
        "Provider returned non-JSON response (HTTP 401): Authentication Fails (governor)",
      ),
    ).toBe("auth");
  });

  it("distinguishes proxy/network, timeout, quota, and model errors", () => {
    expect(classifyActionableError("proxy connection refused")).toBe("network");
    expect(classifyActionableError("UND_ERR_CONNECT_TIMEOUT")).toBe("timeout");
    expect(classifyActionableError("HTTP 429: too many requests")).toBe(
      "rate-limited",
    );
    expect(classifyActionableError("HTTP 404: unknown model")).toBe(
      "not-found",
    );
  });

  it("recognises structured runtime output failures", () => {
    expect(
      classifyActionableError(
        'Runtime "tracker" exhausted the tool loop after 2 steps without producing final output.',
      ),
    ).toBe("invalid-output");
    expect(
      classifyActionableError(
        'Runtime "world-ir" output did not match output.schema: /events/0 must NOT have additional properties',
      ),
    ).toBe("invalid-output");
    expect(
      classifyActionableError(
        'Runtime "generator" expected a JSON envelope per output.schema',
      ),
    ).toBe("invalid-output");
  });
});
