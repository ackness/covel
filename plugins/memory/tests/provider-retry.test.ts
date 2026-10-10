import { describe, expect, it } from "vitest";

import {
  isTransientProviderError,
  retryTransientProviderCall,
} from "../server/provider-retry.js";

describe("provider retry", () => {
  it("does not retry an abort, even when the message looks transient", async () => {
    const abort = Object.assign(new Error("request timed out"), {
      name: "AbortError",
      code: "ABORT_ERR",
    });
    let calls = 0;
    await expect(
      retryTransientProviderCall(
        async () => {
          calls += 1;
          throw abort;
        },
        { initialDelayMs: 0 },
      ),
    ).rejects.toBe(abort);
    expect(calls).toBe(1);

    const wrapped = Object.assign(new Error("fetch failed"), { cause: abort });
    expect(isTransientProviderError(wrapped)).toBe(false);
  });

  it("still retries a transient network failure", async () => {
    let calls = 0;
    const value = await retryTransientProviderCall(
      async () => {
        calls += 1;
        if (calls < 2)
          throw Object.assign(new Error("x"), { code: "ECONNRESET" });
        return "ok";
      },
      { initialDelayMs: 0 },
    );
    expect(value).toBe("ok");
    expect(calls).toBe(2);
  });
});
