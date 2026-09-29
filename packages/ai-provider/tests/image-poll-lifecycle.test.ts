import { afterEach, expect, it, vi } from "vitest";
import { dashscopeWanWire } from "../src/image/dashscope-wan-wire.js";

afterEach(() => vi.unstubAllGlobals());

it("cancels a transient poll body before sending the next request", async () => {
  const cancelled = vi.fn();
  const responses = [
    Response.json({ output: { task_id: "synthetic" } }),
    new Response(new ReadableStream({ cancel: cancelled }), { status: 503 }),
    Response.json({
      output: {
        task_status: "SUCCEEDED",
        results: [{ url: "https://images.example/synthetic.png" }],
      },
    }),
  ];
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => responses.shift()),
  );
  await dashscopeWanWire.generate(
    { baseUrl: "https://provider.example" },
    { model: "wan2.6-image", prompt: "Synthetic" },
    undefined,
    { pollIntervalMs: 1, timeoutMs: 1000 },
  );
  expect(cancelled).toHaveBeenCalledOnce();
});

it("aborts a stalled poll at its own deadline before accepting late success", async () => {
  let pollSignal: AbortSignal | null | undefined;
  let calls = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url, init) => {
      if (++calls === 1)
        return Response.json({ output: { task_id: "synthetic" } });
      pollSignal = init.signal;
      return new Promise<Response>((resolve, reject) => {
        const late = setTimeout(
          () =>
            resolve(
              Response.json({
                output: {
                  task_status: "SUCCEEDED",
                  results: [{ url: "https://images.example/late.png" }],
                },
              }),
            ),
          120,
        );
        const abort = () => {
          clearTimeout(late);
          reject(pollSignal!.reason);
        };
        if (pollSignal?.aborted) abort();
        else pollSignal?.addEventListener("abort", abort, { once: true });
      });
    }),
  );
  await expect(
    dashscopeWanWire.generate(
      { baseUrl: "https://provider.example" },
      { model: "wan2.6-image", prompt: "Synthetic" },
      undefined,
      { pollIntervalMs: 1, timeoutMs: 20 },
    ),
  ).rejects.toThrow(/timed out/);
  expect(pollSignal?.aborted).toBe(true);
});
