import { describe, expect, it } from "vitest";
import {
  isSystemProxyResolveRequest,
  isSystemProxyResolveResponse,
} from "../src/system-proxy-ipc.js";

describe("system proxy IPC protocol", () => {
  it("accepts only bounded HTTP(S) requests", () => {
    expect(
      isSystemProxyResolveRequest({
        type: "covel:system-proxy:resolve",
        version: 1,
        requestId: "request-1",
        url: "https://provider.example/v1/models",
      }),
    ).toBe(true);
    expect(
      isSystemProxyResolveRequest({
        type: "covel:system-proxy:resolve",
        version: 1,
        requestId: "request-2",
        url: "file:///etc/passwd",
      }),
    ).toBe(false);
  });

  it("requires exactly one bounded response payload", () => {
    expect(
      isSystemProxyResolveResponse({
        type: "covel:system-proxy:resolved",
        version: 1,
        requestId: "request-1",
        result: "PROXY proxy.example:8080; DIRECT",
      }),
    ).toBe(true);
    expect(
      isSystemProxyResolveResponse({
        type: "covel:system-proxy:resolved",
        version: 1,
        requestId: "request-1",
        result: "DIRECT",
        error: "unexpected",
      }),
    ).toBe(false);
  });
});
