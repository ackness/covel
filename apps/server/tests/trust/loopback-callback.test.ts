import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import {
  LoopbackCallbackError,
  startLoopbackCallbackSession,
  type LoopbackCallbackSession,
} from "../../src/trust/loopback-callback.js";

describe("startLoopbackCallbackSession", () => {
  const sessions: LoopbackCallbackSession[] = [];

  afterEach(async () => {
    while (sessions.length > 0) {
      await sessions.pop()?.close();
    }
  });

  it("binds ephemeral 127.0.0.1 port, ignores non-matching requests, captures single GET callback, and closes immediately", async () => {
    const session = await startLoopbackCallbackSession({
      path: "/auth/callback",
    });
    sessions.push(session);

    expect(session.port).toBeGreaterThan(0);
    expect(session.callbackUrl).toBe(
      `http://127.0.0.1:${session.port}/auth/callback`,
    );

    const waitPromise = session.waitForCallback();

    const wrongPath = await fetch(
      `http://127.0.0.1:${session.port}/wrong-path?code=1`,
    );
    expect(wrongPath.status).toBe(404);

    const wrongMethod = await fetch(session.callbackUrl, { method: "POST" });
    expect(wrongMethod.status).toBe(405);

    const hit = await fetch(
      `${session.callbackUrl}?code=oauth-code-1&state=csrf-42`,
    );
    expect(hit.status).toBe(200);
    expect(hit.headers.get("cache-control")).toBe("no-store");
    expect(hit.headers.get("content-security-policy")).toBe(
      "default-src 'none'",
    );
    expect(await hit.text()).toContain("Authorization received");

    const result = await waitPromise;
    expect(result.callbackUrl).toBe(
      `${session.callbackUrl}?code=oauth-code-1&state=csrf-42`,
    );
    expect(result.query).toEqual({
      code: "oauth-code-1",
      state: "csrf-42",
    });

    // Port closes immediately once callback completes.
    await new Promise((r) => setTimeout(r, 25));
    await expect(fetch(session.callbackUrl)).rejects.toThrow();
  });

  it("tries preferred ports and falls back cleanly to an ephemeral port when busy", async () => {
    const blocker = http.createServer((_req, res) => res.end("busy"));
    await new Promise<void>((resolve) =>
      blocker.listen(0, "127.0.0.1", resolve),
    );
    const busyPort = (blocker.address() as AddressInfo).port;

    try {
      const session = await startLoopbackCallbackSession({
        path: "/callback",
        ports: [busyPort],
      });
      sessions.push(session);

      expect(session.port).not.toBe(busyPort);
      expect(session.port).toBeGreaterThan(0);
      expect(session.callbackUrl).toBe(
        `http://127.0.0.1:${session.port}/callback`,
      );
    } finally {
      await new Promise<void>((resolve) => blocker.close(() => resolve()));
    }
  });

  it("auto-closes on timeout with LoopbackCallbackError(timeout)", async () => {
    const session = await startLoopbackCallbackSession({
      path: "/timeout-cb",
      timeoutMs: 1_000,
    });
    sessions.push(session);

    await expect(session.waitForCallback()).rejects.toMatchObject({
      name: "LoopbackCallbackError",
      code: "timeout",
    });
    // Server must no longer accept connections after timeout.
    await new Promise((r) => setTimeout(r, 25));
    await expect(fetch(session.callbackUrl)).rejects.toThrow();
  });

  it("rejects invalid paths and supports idempotent close() on abort", async () => {
    await expect(
      startLoopbackCallbackSession({ path: "../escape" }),
    ).rejects.toBeInstanceOf(LoopbackCallbackError);

    const ac = new AbortController();
    const session = await startLoopbackCallbackSession({
      path: "/abort-cb",
      signal: ac.signal,
    });
    sessions.push(session);

    const waiting = session.waitForCallback();
    ac.abort();
    await expect(waiting).rejects.toMatchObject({ code: "aborted" });
    await session.close();
    await session.close();
  });

  it("accepts IPv6 ::1 callback connections when ::1 loopback is available and closes both listeners afterwards", async () => {
    const session = await startLoopbackCallbackSession({
      path: "/auth/callback",
    });
    sessions.push(session);

    const waitPromise = session.waitForCallback();
    let ipv6Delivered = false;
    try {
      const res = await fetch(
        `http://[::1]:${session.port}/auth/callback?code=v6-code&state=s6`,
      );
      expect(res.status).toBe(200);
      ipv6Delivered = true;
    } catch {
      // Environments without ::1 loopback fall back cleanly to 127.0.0.1.
      const res = await fetch(`${session.callbackUrl}?code=v4-code&state=s4`);
      expect(res.status).toBe(200);
    }

    const result = await waitPromise;
    expect(result.query.code).toBe(ipv6Delivered ? "v6-code" : "v4-code");
    await new Promise((r) => setTimeout(r, 25));
    await expect(fetch(session.callbackUrl)).rejects.toThrow();
    if (ipv6Delivered) {
      await expect(
        fetch(`http://[::1]:${session.port}/auth/callback`),
      ).rejects.toThrow();
    }
  });
});
