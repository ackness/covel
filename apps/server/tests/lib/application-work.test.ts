import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createApplicationWork,
  streamOwnedSSE,
  trackRequestWork,
  type RequestWork,
} from "../../src/application-work.js";
import { createServerResourceDrain } from "../../src/server-resources.js";

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

describe("application work ownership", () => {
  it("unblocks backpressured SSE writes when the host closes", async () => {
    const work = createApplicationWork();
    const app = new Hono();
    app.use("*", work.middleware);
    let finished = 0;
    app.get("/stream", (c) =>
      streamOwnedSSE(c, async (stream) => {
        await stream.writeSSE({ data: "first" });
        await stream.writeSSE({ data: "blocked" });
        finished++;
      }),
    );
    const responses = await Promise.all(
      Array.from({ length: 16 }, () => app.request("/stream")),
    );
    expect(finished).toBe(0);
    await work.close();
    expect(finished).toBe(16);
    await Promise.all(responses.map((response) => response.body!.cancel()));
  });

  it("keeps storage open after real HTTP sockets close until the async handler finishes", async () => {
    const work = createApplicationWork();
    const app = new Hono();
    app.use("*", work.middleware);
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let handlerFinished = false;
    const closeStore = vi.fn(async () => {
      expect(handlerFinished).toBe(true);
    });
    app.get("/held", async (c) => {
      entered.resolve();
      await release.promise;
      handlerFinished = true;
      return c.text("finished");
    });
    const listening = Promise.withResolvers<number>();
    const server = serve(
      { fetch: app.fetch, port: 0, hostname: "127.0.0.1" },
      (info) => listening.resolve(info.port),
    );
    const port = await listening.promise;
    const request = fetch(`http://127.0.0.1:${port}/held`).catch(() => null);
    const drain = createServerResourceDrain({
      applicationWork: work,
      store: { close: closeStore },
      worldWatchers: [],
    });
    let closing: Promise<void> | undefined;
    try {
      await entered.promise;
      const closed = new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        server.closeAllConnections();
      });
      await closed;
      expect(handlerFinished).toBe(false);
      closing = drain();
      await tick();
      expect(closeStore).not.toHaveBeenCalled();
      const rejected = await app.request("/held");
      expect(rejected.status).toBe(503);
      expect(await rejected.json()).toMatchObject({
        code: "server_shutting_down",
      });
    } finally {
      release.resolve();
      await request;
      await (closing ?? drain());
      server.closeAllConnections();
      server.close();
    }
    expect(closeStore).toHaveBeenCalledOnce();
  });

  it("owns an SSE callback through cancellation cleanup without treating client disconnect as host shutdown", async () => {
    const work = createApplicationWork();
    const app = new Hono();
    app.use("*", work.middleware);
    const started = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const cleanupStarted = Promise.withResolvers<void>();
    const cleanup = Promise.withResolvers<void>();
    let signal!: AbortSignal;
    app.get("/stream", (c) =>
      streamOwnedSSE(c, async () => {
        signal = c.get("requestWork")!.signal;
        try {
          started.resolve();
          await release.promise;
        } finally {
          cleanupStarted.resolve();
          await cleanup.promise;
        }
      }),
    );
    const response = await app.request("/stream");
    await started.promise;
    await response.body!.cancel();
    expect(signal.aborted).toBe(false);
    let finished = false;
    const closing = work.close();
    expect(work.close()).toBe(closing);
    void closing.then(() => {
      finished = true;
    });
    expect(signal.aborted).toBe(true);
    try {
      release.resolve();
      await cleanupStarted.promise;
      await tick();
      expect(finished).toBe(false);
    } finally {
      cleanup.resolve();
      await closing;
    }
  });

  it("includes children started by admitted work after the response and shutdown", async () => {
    const work = createApplicationWork();
    const app = new Hono();
    app.use("*", work.middleware);
    const startChild = Promise.withResolvers<void>();
    const childStarted = Promise.withResolvers<void>();
    const releaseChild = Promise.withResolvers<void>();
    let lease!: RequestWork;
    let child!: Promise<void>;
    app.get("/fork", (c) => {
      lease = c.get("requestWork")!;
      child = trackRequestWork(c, async () => {
        await startChild.promise;
        void trackRequestWork(c, async () => {
          childStarted.resolve();
          await releaseChild.promise;
        });
      });
      return c.text("accepted");
    });
    expect((await app.request("/fork")).status).toBe(200);
    let closed = false;
    const closing = work.close().then(() => {
      closed = true;
    });
    try {
      startChild.resolve();
      await childStarted.promise;
      await child;
      await tick();
      expect(closed).toBe(false);
    } finally {
      releaseChild.resolve();
      await closing;
    }
    await expect(lease.track(async () => {})).rejects.toThrow(
      "already complete",
    );
  });

  it("releases failed requests and does not close another host's admissions", async () => {
    const first = createApplicationWork();
    const second = createApplicationWork();
    const a = new Hono();
    const b = new Hono();
    a.use("*", first.middleware);
    a.onError((_error, c) => c.text("failed", 500));
    a.get("/", () => {
      throw new Error("synthetic failure");
    });
    b.use("*", second.middleware);
    b.get("/", (c) =>
      c.json({ aborted: c.get("requestWork")!.signal.aborted }),
    );
    expect((await a.request("/")).status).toBe(500);
    await first.close();
    expect((await a.request("/")).status).toBe(503);
    expect(await (await b.request("/")).json()).toEqual({ aborted: false });
    await second.close();
  });

  it("retains dependencies when uncooperative foreground work exceeds the drain budget", async () => {
    vi.useFakeTimers();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const work = createApplicationWork();
    const app = new Hono();
    app.use("*", work.middleware);
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    app.get("/", async (c) => {
      entered.resolve();
      await release.promise;
      return c.text("done");
    });
    const request = app.request("/");
    await entered.promise;
    const closeStore = vi.fn(async () => {});
    const closing = createServerResourceDrain({
      applicationWork: work,
      store: { close: closeStore },
      worldWatchers: [],
    })();
    try {
      await vi.advanceTimersByTimeAsync(2_000);
      await closing;
      expect(closeStore).not.toHaveBeenCalled();
    } finally {
      release.resolve();
      await request;
      await work.close();
    }
    expect(closeStore).not.toHaveBeenCalled();
  });
});
