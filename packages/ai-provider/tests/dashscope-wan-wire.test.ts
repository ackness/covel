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

afterEach(() => vi.unstubAllGlobals());

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
});
