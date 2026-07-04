import { describe, it, expect, vi, afterEach } from "vitest";
import { openAiImagesWire } from "../src/image/openai-images-wire.js";

const PNG_B64 = Buffer.from(
  "fakepngbytes-fakepngbytes-fakepngbytes-fakepngbytes-fakepng0000",
).toString("base64");

function mockFetchOnce(status: number, json: unknown) {
  const fn = vi.fn(async () => ({
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? "OK" : "Bad Request",
    text: async () => JSON.stringify(json),
  })) as unknown as typeof fetch;
  vi.stubGlobal("fetch", fn);
  return fn;
}

afterEach(() => vi.unstubAllGlobals());

describe("openai-images wire", () => {
  it("posts to /v1/images/generations with normalized endpoint (base without /v1)", async () => {
    const fn = mockFetchOnce(200, { data: [{ b64_json: PNG_B64 }] });
    await openAiImagesWire.generate(
      { baseUrl: "https://api.example.com/", apiKey: "k" },
      { model: "gpt-image-1", prompt: "a cat" },
    );
    expect(fn).toHaveBeenCalledWith(
      "https://api.example.com/v1/images/generations",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("does not double the /v1 segment", async () => {
    const fn = mockFetchOnce(200, { data: [{ b64_json: PNG_B64 }] });
    await openAiImagesWire.generate(
      { baseUrl: "https://api.example.com/v1", apiKey: "k" },
      { model: "m", prompt: "p" },
    );
    expect(fn).toHaveBeenCalledWith(
      "https://api.example.com/v1/images/generations",
      expect.anything(),
    );
  });

  it("normalizes size separator and includes optional fields only when set", async () => {
    const fn = mockFetchOnce(200, { data: [{ b64_json: PNG_B64 }] });
    await openAiImagesWire.generate(
      { baseUrl: "https://x.test", apiKey: "k" },
      { model: "m", prompt: "p", size: "1024*1536", quality: "high", n: 2 },
    );
    const body = JSON.parse(
      (fn.mock.calls[0]![1] as RequestInit).body as string,
    );
    expect(body).toEqual({
      model: "m",
      prompt: "p",
      n: 2,
      size: "1024x1536",
      quality: "high",
    });
  });

  it("adds background field and no warning when transparent requested", async () => {
    const fn = mockFetchOnce(200, { data: [{ b64_json: PNG_B64 }] });
    const result = await openAiImagesWire.generate(
      { baseUrl: "https://x.test", apiKey: "k" },
      { model: "m", prompt: "p", background: "transparent" },
    );
    const body = JSON.parse(
      (fn.mock.calls[0]![1] as RequestInit).body as string,
    );
    expect(body.background).toBe("transparent");
    expect(result.warnings).toEqual([]);
  });

  it("parses data[] b64_json and url entries", async () => {
    mockFetchOnce(200, {
      data: [{ b64_json: PNG_B64 }, { url: "https://cdn.test/i.png" }],
      output_format: "png",
    });
    const result = await openAiImagesWire.generate(
      { baseUrl: "https://x.test", apiKey: "k" },
      { model: "m", prompt: "p" },
    );
    expect(result.images).toHaveLength(2);
    expect(result.images[0]).toMatchObject({
      kind: "bytes",
      mime: "image/png",
    });
    expect(result.images[1]).toMatchObject({
      kind: "url",
      url: "https://cdn.test/i.png",
    });
  });

  it("parses choices[].message.content[] shim shape", async () => {
    mockFetchOnce(200, {
      choices: [
        { message: { content: [{ image: PNG_B64, mimeType: "image/webp" }] } },
      ],
    });
    const result = await openAiImagesWire.generate(
      { baseUrl: "https://x.test", apiKey: "k" },
      { model: "m", prompt: "p" },
    );
    expect(result.images[0]).toMatchObject({
      kind: "bytes",
      mime: "image/webp",
    });
  });

  it("throws a structured error with the provider message on !ok", async () => {
    mockFetchOnce(400, { error: { message: "bad prompt" } });
    await expect(
      openAiImagesWire.generate(
        { baseUrl: "https://x.test", apiKey: "k" },
        { model: "m", prompt: "p" },
      ),
    ).rejects.toThrow(/bad prompt/);
  });

  it("throws when response contains zero images", async () => {
    mockFetchOnce(200, { data: [] });
    await expect(
      openAiImagesWire.generate(
        { baseUrl: "https://x.test", apiKey: "k" },
        { model: "m", prompt: "p" },
      ),
    ).rejects.toThrow(/no images/i);
  });

  it("strips imageWire from providerRequestMetadata but keeps other keys", async () => {
    const fn = mockFetchOnce(200, { data: [{ b64_json: PNG_B64 }] });
    await openAiImagesWire.generate(
      { baseUrl: "https://x.test", apiKey: "k" },
      {
        model: "m",
        prompt: "p",
        providerRequestMetadata: { imageWire: "openai-images", style: "vivid" },
      },
    );
    const body = JSON.parse(
      (fn.mock.calls[0]![1] as RequestInit).body as string,
    );
    expect(body.style).toBe("vivid");
    expect(body).not.toHaveProperty("imageWire");
  });

  it("records a warning when negativePrompt is provided (unsupported field)", async () => {
    mockFetchOnce(200, { data: [{ b64_json: PNG_B64 }] });
    const result = await openAiImagesWire.generate(
      { baseUrl: "https://x.test", apiKey: "k" },
      { model: "m", prompt: "p", negativePrompt: "ugly" },
    );
    expect(result.warnings.join(" ")).toMatch(/negative-prompt/i);
  });

  it("throws when baseUrl is empty or missing", async () => {
    await expect(
      openAiImagesWire.generate(
        { baseUrl: "", apiKey: "k" },
        { model: "m", prompt: "p" },
      ),
    ).rejects.toThrow(/baseUrl is required/);
    await expect(
      openAiImagesWire.generate({ apiKey: "k" }, { model: "m", prompt: "p" }),
    ).rejects.toThrow(/baseUrl is required/);
  });

  it("throws on non-JSON response body", async () => {
    const fn = vi.fn(async () => ({
      ok: true,
      status: 200,
      statusText: "OK",
      text: async () => "oops",
    })) as unknown as typeof fetch;
    vi.stubGlobal("fetch", fn);
    await expect(
      openAiImagesWire.generate(
        { baseUrl: "https://x.test", apiKey: "k" },
        { model: "m", prompt: "p" },
      ),
    ).rejects.toThrow(/non-JSON/);
  });
});
