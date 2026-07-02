import { describe, it, expect, vi, afterEach } from "vitest";
import { dashscopeWanWire } from "../src/image/dashscope-wan-wire.js";

type FetchCall = { url: string; init?: RequestInit };

function stubFetchSequence(
  responses: Array<{ status?: number; json: unknown }>,
) {
  const calls: FetchCall[] = [];
  let i = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      const r = responses[Math.min(i++, responses.length - 1)]!;
      const status = r.status ?? 200;
      return {
        ok: status >= 200 && status < 300,
        status,
        statusText: "X",
        text: async () => JSON.stringify(r.json),
        json: async () => r.json,
      };
    }) as unknown as typeof fetch,
  );
  return calls;
}

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.COVEL_LLM_RETRY_DISABLED;
});

describe("dashscope-wan wire", () => {
  it("submits with async header and star-separated size, then polls to SUCCEEDED", async () => {
    const calls = stubFetchSequence([
      { json: { output: { task_id: "t1" } } },
      { json: { output: { task_status: "RUNNING" } } },
      {
        json: {
          output: {
            task_status: "SUCCEEDED",
            results: [{ url: "https://oss.test/a.png" }],
          },
        },
      },
    ]);
    const result = await dashscopeWanWire.generate(
      { baseUrl: "https://dashscope.test", apiKey: "k" },
      { model: "wan2.2-t2i", prompt: "p", size: "1024x1536" },
      undefined,
      { pollIntervalMs: 1, timeoutMs: 5_000 },
    );
    expect(calls[0]!.url).toBe(
      "https://dashscope.test/api/v1/services/aigc/image-generation/generation",
    );
    const headers = calls[0]!.init!.headers as Record<string, string>;
    expect(headers["X-DashScope-Async"]).toBe("enable");
    const body = JSON.parse(calls[0]!.init!.body as string);
    expect(body.parameters.size).toBe("1024*1536");
    expect(body.input.messages[0].content[0].text).toBe("p");
    expect(calls[1]!.url).toBe("https://dashscope.test/api/v1/tasks/t1");
    expect(result.images[0]).toMatchObject({
      kind: "url",
      url: "https://oss.test/a.png",
    });
  });

  it("strips negative_prompt for wan2.7-image* models and records a warning", async () => {
    const calls = stubFetchSequence([
      { json: { output: { task_id: "t" } } },
      {
        json: {
          output: {
            task_status: "SUCCEEDED",
            results: [{ url: "https://o.test/x.png" }],
          },
        },
      },
    ]);
    const result = await dashscopeWanWire.generate(
      { baseUrl: "https://d.test", apiKey: "k" },
      { model: "wan2.7-image-pro", prompt: "p", negativePrompt: "ugly" },
      undefined,
      { pollIntervalMs: 1, timeoutMs: 5_000 },
    );
    const body = JSON.parse(calls[0]!.init!.body as string);
    expect(body.parameters.negative_prompt).toBeUndefined();
    expect(result.warnings.join(" ")).toMatch(/negative/i);
  });

  it("throws with provider message on FAILED", async () => {
    stubFetchSequence([
      { json: { output: { task_id: "t" } } },
      { json: { output: { task_status: "FAILED", message: "quota" } } },
    ]);
    await expect(
      dashscopeWanWire.generate(
        { baseUrl: "https://d.test", apiKey: "k" },
        { model: "m", prompt: "p" },
        undefined,
        { pollIntervalMs: 1, timeoutMs: 5_000 },
      ),
    ).rejects.toThrow(/FAILED: quota/);
  });

  it("times out when polling exceeds deadline", async () => {
    stubFetchSequence([
      { json: { output: { task_id: "t" } } },
      { json: { output: { task_status: "RUNNING" } } },
    ]);
    await expect(
      dashscopeWanWire.generate(
        { baseUrl: "https://d.test", apiKey: "k" },
        { model: "m", prompt: "p" },
        undefined,
        { pollIntervalMs: 1, timeoutMs: 10 },
      ),
    ).rejects.toThrow(/timed out/);
  });

  it("parses wan2.7 choices[].message.content[] result shape", async () => {
    stubFetchSequence([
      { json: { output: { task_id: "t" } } },
      {
        json: {
          output: {
            task_status: "SUCCEEDED",
            choices: [
              { message: { content: [{ image: "https://o.test/i.png" }] } },
            ],
          },
        },
      },
    ]);
    const result = await dashscopeWanWire.generate(
      { baseUrl: "https://d.test", apiKey: "k" },
      { model: "m", prompt: "p" },
      undefined,
      { pollIntervalMs: 1, timeoutMs: 5_000 },
    );
    expect(result.images[0]).toMatchObject({ kind: "url" });
  });

  it("passes the same AbortSignal to submit and poll requests", async () => {
    const calls = stubFetchSequence([
      { json: { output: { task_id: "t1" } } },
      {
        json: {
          output: {
            task_status: "SUCCEEDED",
            results: [{ url: "https://oss.test/a.png" }],
          },
        },
      },
    ]);
    const controller = new AbortController();
    await dashscopeWanWire.generate(
      { baseUrl: "https://d.test", apiKey: "k", signal: controller.signal },
      { model: "m", prompt: "p" },
      undefined,
      { pollIntervalMs: 1, timeoutMs: 5_000 },
    );
    expect(calls[0]!.init!.signal).toBe(controller.signal);
    expect(calls[1]!.init!.signal).toBe(controller.signal);
  });

  it("warns for unsupported background and clamps n to 1", async () => {
    stubFetchSequence([
      { json: { output: { task_id: "t1" } } },
      {
        json: {
          output: {
            task_status: "SUCCEEDED",
            results: [{ url: "https://oss.test/a.png" }],
          },
        },
      },
    ]);
    const result = await dashscopeWanWire.generate(
      { baseUrl: "https://d.test", apiKey: "k" },
      { model: "m", prompt: "p", background: "transparent", n: 3 },
      undefined,
      { pollIntervalMs: 1, timeoutMs: 5_000 },
    );
    expect(result.warnings.join(" ")).toMatch(/transparent/i);
    expect(result.warnings.join(" ")).toMatch(/clamped to 1/i);
  });

  it("writes negative_prompt for models that accept it", async () => {
    const calls = stubFetchSequence([
      { json: { output: { task_id: "t1" } } },
      {
        json: {
          output: {
            task_status: "SUCCEEDED",
            results: [{ url: "https://oss.test/a.png" }],
          },
        },
      },
    ]);
    await dashscopeWanWire.generate(
      { baseUrl: "https://d.test", apiKey: "k" },
      { model: "wan2.2-t2i", prompt: "p", negativePrompt: "ugly" },
      undefined,
      { pollIntervalMs: 1, timeoutMs: 5_000 },
    );
    const body = JSON.parse(calls[0]!.init!.body as string);
    expect(body.parameters.negative_prompt).toBe("ugly");
  });

  it("throws a structured error when submit request fails", async () => {
    // Avoid postJson's built-in 5xx retry/backoff — this test is about the
    // wire's error surfacing, not the shared retry wrapper (covered by
    // http-retry.test.ts).
    process.env.COVEL_LLM_RETRY_DISABLED = "1";
    stubFetchSequence([{ status: 500, json: { message: "internal error" } }]);
    await expect(
      dashscopeWanWire.generate(
        { baseUrl: "https://d.test", apiKey: "k" },
        { model: "m", prompt: "p" },
        undefined,
        { pollIntervalMs: 1, timeoutMs: 5_000 },
      ),
    ).rejects.toThrow(/internal error/);
  });

  it("throws when submit response has no task_id", async () => {
    stubFetchSequence([{ json: { output: {} } }]);
    await expect(
      dashscopeWanWire.generate(
        { baseUrl: "https://d.test", apiKey: "k" },
        { model: "m", prompt: "p" },
        undefined,
        { pollIntervalMs: 1, timeoutMs: 5_000 },
      ),
    ).rejects.toThrow(/no task_id/);
  });

  it("retries past a transient poll failure and still succeeds", async () => {
    stubFetchSequence([
      { json: { output: { task_id: "t1" } } },
      { status: 503, json: {} },
      {
        json: {
          output: {
            task_status: "SUCCEEDED",
            results: [{ url: "https://oss.test/a.png" }],
          },
        },
      },
    ]);
    const result = await dashscopeWanWire.generate(
      { baseUrl: "https://d.test", apiKey: "k" },
      { model: "m", prompt: "p" },
      undefined,
      { pollIntervalMs: 1, timeoutMs: 5_000 },
    );
    expect(result.images[0]).toMatchObject({ kind: "url" });
  });

  it("throws immediately on a non-retriable poll failure (4xx except 429)", async () => {
    const calls = stubFetchSequence([
      { json: { output: { task_id: "t1" } } },
      { status: 400, json: { message: "bad task id" } },
    ]);
    await expect(
      dashscopeWanWire.generate(
        { baseUrl: "https://d.test", apiKey: "k" },
        { model: "m", prompt: "p" },
        undefined,
        { pollIntervalMs: 1, timeoutMs: 5_000 },
      ),
    ).rejects.toThrow(/bad task id/);
    // Submit + exactly one poll attempt — no retry loop for a hard 4xx.
    expect(calls).toHaveLength(2);
  });

  it("aborts mid-poll-sleep without waiting the full interval", async () => {
    stubFetchSequence([
      { json: { output: { task_id: "t1" } } },
      { json: { output: { task_status: "RUNNING" } } },
    ]);
    const controller = new AbortController();
    const start = Date.now();
    const promise = dashscopeWanWire.generate(
      { baseUrl: "https://d.test", apiKey: "k", signal: controller.signal },
      { model: "m", prompt: "p" },
      undefined,
      { pollIntervalMs: 5_000, timeoutMs: 60_000 },
    );
    // Submit + first poll resolve on microtasks (no real delay); abort well
    // before the 5s sleep before the second poll would otherwise elapse.
    setTimeout(() => controller.abort(), 30);
    await expect(promise).rejects.toThrow(/abort/i);
    expect(Date.now() - start).toBeLessThan(2_000);
  });
});
