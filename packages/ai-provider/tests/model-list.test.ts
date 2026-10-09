import { afterEach, describe, expect, it, vi } from "vitest";

import { listProtocolModels } from "../src/protocol-registry.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

function stubList(payload: unknown) {
  const fetchMock = vi.fn().mockResolvedValue(Response.json(payload));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("listProtocolModels", () => {
  it("reads an OpenAI-style list with the bearer key", async () => {
    const fetchMock = stubList({
      data: [{ id: "b" }, { id: "a" }, { id: "b" }],
    });
    expect(
      await listProtocolModels(
        "openai-chat-v1",
        { baseUrl: "https://api.groq.com/openai/v1", apiKey: "k" },
        "groq",
      ),
    ).toEqual(["a", "b"]);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://api.groq.com/openai/v1/models");
    expect(new Headers(init.headers).get("authorization")).toBe("Bearer k");
  });

  it("reads Anthropic's list with its own key header", async () => {
    const fetchMock = stubList({ data: [{ id: "claude-sonnet-5" }] });
    expect(
      await listProtocolModels(
        "anthropic-messages-v1",
        { baseUrl: "https://api.anthropic.com", apiKey: "k" },
        "anthropic",
      ),
    ).toEqual(["claude-sonnet-5"]);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://api.anthropic.com/v1/models?limit=1000");
    const headers = new Headers(init.headers);
    expect(headers.get("x-api-key")).toBe("k");
    expect(headers.has("authorization")).toBe(false);
  });

  it("reads Gemini's list without the `models/` prefix", async () => {
    const fetchMock = stubList({
      models: [
        { name: "models/gemini-3-flash" },
        { name: "models/gemini-3-pro" },
      ],
    });
    expect(
      await listProtocolModels(
        "google-generative-ai-v1",
        {
          baseUrl: "https://generativelanguage.googleapis.com/v1beta",
          apiKey: "k",
        },
        "google",
      ),
    ).toEqual(["gemini-3-flash", "gemini-3-pro"]);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe(
      "https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000",
    );
    expect(new Headers(init.headers).get("x-goog-api-key")).toBe("k");
  });

  it("refuses a protocol that has no model list", async () => {
    await expect(
      listProtocolModels(
        "vercel-evaluation-v4",
        { baseUrl: "https://ai-gateway.vercel.sh/v1" },
        "vercel",
      ),
    ).rejects.toThrow(/has no model list/);
  });
});
