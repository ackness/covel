/**
 * app.onError logs request context on every 500 — the URL must not leak
 * signed media tokens or SSE session_token owner auth into logs.
 */

import { describe, expect, it, vi } from "vitest";
import type { Context } from "hono";
import {
  makeErrorHandler,
  redactSensitiveQueryParamsInText,
} from "../../src/api-error.js";

function fakeContext(url: string): Context {
  return {
    req: { method: "GET", url },
    json: (body: unknown, status: number) => ({ body, status }),
  } as unknown as Context;
}

describe("makeErrorHandler", () => {
  it("redacts the media token query param from the logged URL", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const handler = makeErrorHandler("test", false);
    handler(
      new Error("boom"),
      fakeContext("http://localhost/api/media/abc?token=super-secret"),
    );
    const logged = spy.mock.calls[0]?.[0] as string;
    expect(logged).not.toContain("super-secret");
    expect(logged).toContain("token=%5Bredacted%5D");
    spy.mockRestore();
  });

  it("redacts the session_token query param from the logged URL", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const handler = makeErrorHandler("test", false);
    handler(
      new Error("boom"),
      fakeContext(
        "http://localhost/api/sessions/foo/events?session_token=owner-secret",
      ),
    );
    const logged = spy.mock.calls[0]?.[0] as string;
    expect(logged).not.toContain("owner-secret");
    expect(logged).toContain("session_token=%5Bredacted%5D");
    spy.mockRestore();
  });

  it("leaves URLs without sensitive params untouched", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const handler = makeErrorHandler("test", false);
    handler(new Error("boom"), fakeContext("http://localhost/api/health"));
    const logged = spy.mock.calls[0]?.[0] as string;
    expect(logged).toContain("http://localhost/api/health");
    spy.mockRestore();
  });
});

describe("redactSensitiveQueryParamsInText", () => {
  it("redacts sensitive params in Hono relative request log lines", () => {
    const logged = redactSensitiveQueryParamsInText(
      "<-- GET /api/events?session_token=owner-secret&token=media-secret&keep=1",
    );

    expect(logged).not.toContain("owner-secret");
    expect(logged).not.toContain("media-secret");
    expect(logged).toContain("session_token=[redacted]");
    expect(logged).toContain("token=[redacted]");
    expect(logged).toContain("keep=1");
  });

  it("does not redact similarly named query params", () => {
    expect(
      redactSensitiveQueryParamsInText(
        "--> GET /api/events?access_token=public&token_hint=visible",
      ),
    ).toContain("access_token=public&token_hint=visible");
  });

  it("redacts URL-encoded sensitive parameter names", () => {
    const logged = redactSensitiveQueryParamsInText(
      "<-- GET /api/events?session%5Ftoken=owner-secret",
    );
    expect(logged).not.toContain("owner-secret");
    expect(logged).toContain("session_token=[redacted]");
  });
});
