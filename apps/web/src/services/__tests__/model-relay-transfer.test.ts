// @vitest-environment node
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ supported: true }));
vi.mock("@/settings/store", () => ({
  getSettings: () => ({
    get: () => [{ baseUrl: "http://127.0.0.1:3425/v1" }],
  }),
}));
vi.mock("@/services/api/health.js", () => ({
  isModelRelaySupported: () => state.supported,
}));

beforeEach(() => {
  vi.resetModules();
  vi.useFakeTimers();
  state.supported = true;
  vi.stubGlobal("window", { location: { origin: "https://demo.covel.cc" } });
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

async function transfer(chunkReply: () => Promise<Response>) {
  let channel!: ReadableStreamDefaultController<Uint8Array>;
  let upstream!: ReadableStreamDefaultController<Uint8Array>;
  let signal: AbortSignal | undefined;
  const posts: Array<{ phase: string; body: BodyInit | null | undefined }> = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "/api/model-relay/stream") {
        return new Response(
          new ReadableStream({
            start(c) {
              channel = c;
            },
          }),
        );
      }
      if (url.startsWith("/api/model-relay/requests/")) {
        const phase = url.split("/").at(-1)!;
        posts.push({ phase, body: init?.body });
        return phase === "chunk"
          ? chunkReply()
          : new Response(null, { status: 204 });
      }
      signal = init?.signal ?? undefined;
      const body = new ReadableStream<Uint8Array>({
        start(c) {
          upstream = c;
        },
      });
      signal?.addEventListener("abort", () => upstream.error(signal?.reason), {
        once: true,
      });
      return new Response(body);
    }),
  );
  const { modelRelayHeaders } = await import("../model-relay.js");
  modelRelayHeaders();
  await vi.advanceTimersByTimeAsync(0);
  const send = (type: "request" | "cancel") =>
    channel.enqueue(
      new TextEncoder().encode(
        `data: ${JSON.stringify({ type, id: "transfer", url: "http://127.0.0.1:3425/v1/responses", method: "POST" })}\n\n`,
      ),
    );
  send("request");
  await vi.advanceTimersByTimeAsync(0);
  return {
    posts,
    upstream,
    signal: () => signal,
    cancel: () => send("cancel"),
    close: async () => {
      state.supported = false;
      channel.close();
      await vi.runAllTimersAsync();
    },
  };
}

it("aborts a refused chunk without posting end or reporting successful completion", async () => {
  const run = await transfer(async () => new Response(null, { status: 410 }));
  run.upstream.enqueue(new Uint8Array(262144));
  await vi.advanceTimersByTimeAsync(0);
  expect(run.signal()?.aborted).toBe(true);
  expect(run.posts.map((p) => p.phase)).toEqual(["head", "chunk"]);
  await run.close();
});

it("cancels a fulfilled prefetch during POST, sends only a cancellation failure and never end", async () => {
  let acknowledge!: (response: Response) => void;
  const run = await transfer(
    () =>
      new Promise((resolve) => {
        acknowledge = resolve;
      }),
  );
  run.upstream.enqueue(new Uint8Array([1]));
  await vi.advanceTimersByTimeAsync(50);
  run.upstream.enqueue(new Uint8Array(262144));
  await vi.advanceTimersByTimeAsync(1);
  run.cancel();
  await vi.advanceTimersByTimeAsync(1);
  expect(run.signal()?.aborted).toBe(true);
  acknowledge(new Response(null, { status: 204 }));
  await vi.advanceTimersByTimeAsync(0);
  expect(run.posts.map((p) => p.phase)).toEqual(["head", "chunk", "fail"]);
  expect(JSON.parse(String(run.posts.at(-1)?.body))).toEqual({
    message: "the request was cancelled.",
  });
  await run.close();
});

it.each([false, true])(
  "settles an EOF acknowledgement without a false end marker (cancel=%s)",
  async (cancel) => {
    let acknowledge!: (response: Response) => void;
    const run = await transfer(
      () =>
        new Promise((resolve) => {
          acknowledge = resolve;
        }),
    );
    run.upstream.enqueue(new Uint8Array([1, 2]));
    run.upstream.close();
    await vi.advanceTimersByTimeAsync(0);
    expect(run.posts.map((p) => p.phase)).toEqual(["head", "chunk"]);
    if (cancel) {
      run.cancel();
      await vi.advanceTimersByTimeAsync(0);
    }
    acknowledge(new Response(null, { status: 204 }));
    await vi.advanceTimersByTimeAsync(0);
    expect(run.signal()?.aborted).toBe(cancel);
    expect(run.posts.map((p) => p.phase)).toEqual([
      "head",
      "chunk",
      cancel ? "fail" : "end",
    ]);
    await run.close();
  },
);
