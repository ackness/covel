import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import {
  LoopbackCallbackError,
  parseLoopbackCallbackInput,
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
    expect((await fetch(session.callbackUrl)).status).toBe(403);

    const hit = await fetch(
      `${session.callbackUrl}?code=oauth-code-1&state=${session.state}`,
    );
    expect(hit.status).toBe(200);
    expect(hit.headers.get("cache-control")).toBe("no-store");
    expect(hit.headers.get("content-security-policy")).toBe(
      "default-src 'none'",
    );
    expect(await hit.text()).toContain("Authorization received");

    const result = await waitPromise;
    expect(result.callbackUrl).toBe(
      `${session.callbackUrl}?code=oauth-code-1&state=${session.state}`,
    );
    expect(result.query).toEqual({
      code: "oauth-code-1",
      state: session.state,
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

  it("cancels when the signal is aborted while listeners are starting", async () => {
    const controller = new AbortController();
    const starting = startLoopbackCallbackSession({
      path: "/auth/callback",
      signal: controller.signal,
    });
    controller.abort();
    await expect(starting).rejects.toMatchObject({ code: "aborted" });
  });

  it("accepts IPv6 callbacks and closes both listeners afterwards", async ({
    skip,
  }) => {
    const probe = http.createServer();
    const ipv6Available = await new Promise<boolean>((resolve, reject) => {
      probe.once("error", (error: NodeJS.ErrnoException) => {
        if (error.code === "EAFNOSUPPORT" || error.code === "EADDRNOTAVAIL") {
          resolve(false);
        } else {
          reject(error);
        }
      });
      probe.listen(0, "::1", () => probe.close(() => resolve(true)));
    });
    if (!ipv6Available) skip();

    const session = await startLoopbackCallbackSession({
      path: "/auth/callback",
    });
    sessions.push(session);

    const waitPromise = session.waitForCallback();
    const ipv6Url = `http://[::1]:${session.port}/auth/callback`;
    const suffix = `?code=callback-code&state=${session.state}`;
    const response = await fetch(ipv6Url + suffix);
    expect(response.status).toBe(200);

    const result = await waitPromise;
    expect(result.query).toMatchObject({
      code: "callback-code",
      state: session.state,
    });
    await new Promise((r) => setTimeout(r, 25));
    await expect(fetch(session.callbackUrl)).rejects.toThrow();
    await expect(fetch(ipv6Url)).rejects.toThrow();
  });

  it("normalizes full, wrapped, relative, and schemeless loopback callback pastes and rejects foreign inputs", () => {
    expect(
      parseLoopbackCallbackInput(
        '  "http://localhost:1455/auth/callback?code=c1&state=s1"  ',
      )?.searchParams.get("state"),
    ).toBe("s1");
    expect(
      parseLoopbackCallbackInput(
        "<https://127.0.0.1:1455/auth/callback?code=c2&state=s2>",
      )?.searchParams.get("code"),
    ).toBe("c2");
    expect(
      parseLoopbackCallbackInput(
        "localhost:1455/auth/callback?code=c3&state=s3",
      )?.searchParams.get("state"),
    ).toBe("s3");
    expect(
      parseLoopbackCallbackInput("[::1]:1455/auth/callback?code=c4&state=s4")
        ?.hostname,
    ).toBe("[::1]");
    expect(
      parseLoopbackCallbackInput("/auth/callback?code=c5&state=s5")?.pathname,
    ).toBe("/auth/callback");
    expect(
      parseLoopbackCallbackInput("?code=c6&state=s6")?.searchParams.get(
        "state",
      ),
    ).toBe("s6");

    for (const bad of [
      "",
      "   ",
      "evil.example/auth/callback?code=c&state=s",
      "javascript:alert(1)?state=s",
    ]) {
      expect(parseLoopbackCallbackInput(bad)).toBeNull();
    }
  });
});
