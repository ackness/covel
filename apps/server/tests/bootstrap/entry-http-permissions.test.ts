import { afterEach, describe, expect, it, vi } from "vitest";
import {
  getSpeechWire,
  getTextWire,
  withWireRegistrySnapshot,
  type ProviderConfig,
} from "@covel/ai-provider";
import {
  createHookPipeline,
  createPluginRpcRegistry,
  PluginEntryScope,
  type PluginServiceRegistry,
} from "@covel/runtime";
import { createMemoryStore } from "@covel/store/memory";
import { ToolRegistry } from "@covel/tools";
import type { BootstrapPluginEntriesParams } from "../../src/routes/api/bootstrap/plugin-entry.js";
import { buildEntryApi } from "../../src/routes/api/bootstrap/plugin-entry-api.js";

// No request leaves the test: the permission check runs before this stub.
const sent = vi.hoisted(() => [] as string[]);
vi.mock("@covel/ai-provider", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@covel/ai-provider")>()),
  fetchWithRetry: vi.fn(async (input: string | URL) => {
    sent.push(String(input));
    return new Response("ok");
  }),
}));

afterEach(() => {
  sent.length = 0;
});

const DECLARED = [{ origin: "https://api.declared.example" }];

function fixture(source: "builtin" | "community", pluginId: string) {
  const batch = new PluginEntryScope();
  type Handler = { handler: (input: unknown, context: never) => unknown };
  let service: Handler | null = null;
  let extension: Handler | null = null;
  const params: BootstrapPluginEntriesParams = {
    discoveryMap: new Map([
      [
        pluginId,
        {
          id: pluginId,
          rootPath: "/nowhere",
          isMultiRuntime: false,
          pluginMdPaths: [],
          source,
        },
      ],
    ]),
    manifestCache: new Map(),
    store: createMemoryStore(),
    tools: new ToolRegistry(),
    hookPipeline: createHookPipeline(),
    rpcRegistry: createPluginRpcRegistry(),
    services: {
      register: (_pluginId: string, definition: typeof service) => {
        service = definition;
        return () => {};
      },
    } as unknown as PluginServiceRegistry,
  };
  const api = buildEntryApi(
    params,
    pluginId,
    batch,
    ((_point: string, _id: string, definition: Handler) => {
      extension = definition;
    }) as never,
    DECLARED,
  );
  return {
    api,
    batch,
    service: () => service!,
    extension: () => extension!,
  };
}

describe("covel.http of a package's entry", () => {
  it("lets a community entry reach only the origins its package declares", async () => {
    const { api } = fixture("community", "http-community");
    await expect(
      api.http.fetchWithRetry("https://api.declared.example/v1"),
    ).resolves.toBeInstanceOf(Response);
    await expect(
      api.http.fetchWithRetry("https://undeclared.example/collect"),
    ).rejects.toThrow(/http permission denied/);
    await expect(
      api.http.fetchWithRetry("https://api.declared.example/v1", {
        method: "POST",
      }),
    ).rejects.toThrow(/http permission denied/);
    expect(sent).toEqual(["https://api.declared.example/v1"]);
  });

  it("leaves a builtin entry's requests to the SSRF guard alone, as for runtimes", async () => {
    const { api } = fixture("builtin", "http-builtin");
    await api.http.fetchWithRetry("https://undeclared.example/x");
    expect(sent).toEqual(["https://undeclared.example/x"]);
  });

  it("checks a community service against the provider's package, not the caller's utils", async () => {
    const { api, batch, service } = fixture("community", "http-service");
    api.registerService({
      name: "probe",
      contract: "probe@1",
      input: { parse: (value: unknown) => value as string },
      output: { parse: (value: unknown) => value },
      handler: async (url, context) => {
        await context.utils!.fetchWithRetry(url);
        return "sent";
      },
    });
    batch.commit();
    const callerUtils = {
      validateBaseUrl: () => ({ ok: true }),
      fetchWithRetry: vi.fn(async () => new Response("caller")),
    };
    const context = {
      callerPluginId: "caller",
      signal: new AbortController().signal,
      services: {},
      utils: callerUtils,
    } as never;
    await expect(
      service().handler("https://undeclared.example/x", context),
    ).rejects.toThrow(/http permission denied/);
    await expect(
      service().handler("https://api.declared.example/x", context),
    ).resolves.toBe("sent");
    expect(callerUtils.fetchWithRetry).not.toHaveBeenCalled();
    expect(sent).toEqual(["https://api.declared.example/x"]);
  });

  it("checks a community extension provider against its own package, not the kernel's utils", async () => {
    const { api, extension } = fixture("community", "http-extension");
    api.provideExtension("prompt.segment@1", "probe", {
      handler: async (
        _input: unknown,
        context: {
          utils?: { fetchWithRetry(url: string): Promise<Response> };
        },
      ) => {
        await context.utils!.fetchWithRetry("https://undeclared.example/x");
        return [];
      },
    } as never);
    const kernelUtils = {
      validateBaseUrl: () => ({ ok: true }),
      fetchWithRetry: vi.fn(async () => new Response("kernel")),
    };
    await expect(
      extension().handler({}, {
        signal: new AbortController().signal,
        utils: kernelUtils,
      } as never),
    ).rejects.toThrow(/http permission denied/);
    expect(kernelUtils.fetchWithRetry).not.toHaveBeenCalled();
  });

  it("lets a community wire reach the endpoint of the slot it serves, and nothing undeclared", async () => {
    const pluginId = "http-wire";
    const { api, batch } = fixture("community", pluginId);
    api.registerWires({
      speech: [
        {
          id: "tts",
          async synthesize(config: ProviderConfig, params: { text: string }) {
            await api.http.fetchWithRetry(`${config.baseUrl}/speech`, {
              method: "POST",
            });
            if (params.text === "leak")
              await api.http.fetchWithRetry("https://undeclared.example/x");
            return {
              audio: { mimeType: "audio/wav", data: new Uint8Array() },
              usage: null,
              warnings: [],
            };
          },
        },
      ],
      text: [
        {
          id: "chat",
          async generateText() {
            return {
              text: "",
              finishReason: "stop",
              usage: { inputTokens: 0, outputTokens: 0 },
            };
          },
          async *streamText(config: ProviderConfig) {
            await Promise.resolve();
            await api.http.fetchWithRetry(`${config.baseUrl}/stream`);
            yield { type: "text-delta", text: "hi" };
          },
        },
      ],
    } as never);
    batch.commit();
    try {
      await withWireRegistrySnapshot(async () => {
        const wire = getSpeechWire(`${pluginId}/tts`)!;
        const config = { baseUrl: "http://127.0.0.1:8000/v1" };
        await wire.synthesize(config, { model: "m", text: "ok" });
        await expect(
          wire.synthesize(config, { model: "m", text: "leak" }),
        ).rejects.toThrow(/http permission denied/);
        const chunks = [];
        for await (const chunk of getTextWire(`${pluginId}/chat`)!.streamText(
          { baseUrl: "https://player.example" },
          { model: "m", messages: [] } as never,
        ))
          chunks.push(chunk);
        expect(chunks).toHaveLength(1);
      }, [pluginId]);
      // Outside a wire call the slot endpoint is not declared.
      await expect(
        api.http.fetchWithRetry("http://127.0.0.1:8000/v1/speech"),
      ).rejects.toThrow(/http permission denied/);
      expect(sent).toEqual([
        "http://127.0.0.1:8000/v1/speech",
        "http://127.0.0.1:8000/v1/speech",
        "https://player.example/stream",
      ]);
    } finally {
      batch.unpublish();
    }
  });
});
